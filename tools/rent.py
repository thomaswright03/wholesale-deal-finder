#!/usr/bin/env python3
"""
Open Zillow's price-my-rental tool, type an address, click search, print the median rent.

    pip install playwright
    python3 tools/rent.py "6823 Betts Ave, Cincinnati, OH 45239"

Uses your installed Google Chrome. If a CAPTCHA shows up, clear it in the window.
"""
import re
import sys

from playwright.sync_api import sync_playwright

URL = "https://www.zillow.com/rental-manager/price-my-rental/"
RANGE = re.compile(r"\$\s?([\d,]{3,7})\s*(?:-|–|—|to)\s*\$\s?([\d,]{3,7})")
SINGLE = re.compile(r"\$\s?([\d,]{3,7})")


def read_rent(text):
    """Median of the range if there is one, otherwise the lone figure."""
    m = RANGE.search(text)
    if m:
        lo, hi = int(m.group(1).replace(",", "")), int(m.group(2).replace(",", ""))
        return lo, hi, (lo + hi) // 2
    m = SINGLE.search(text)
    if m:
        return None, None, int(m.group(1).replace(",", ""))
    return None, None, None


def main():
    if len(sys.argv) < 2:
        sys.exit('usage: python3 tools/rent.py "street, city, state zip"')
    address = sys.argv[1]

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False, channel="chrome")
        page = browser.new_page(viewport={"width": 1366, "height": 900})
        page.goto(URL, wait_until="domcontentloaded")
        page.wait_for_timeout(1200)

        # 1. type the address
        box = page.get_by_placeholder(re.compile("address", re.I)).first
        box.click()
        box.fill(address)
        page.wait_for_timeout(1500)  # autocomplete needs a beat

        # 2. take the first suggestion if the dropdown opened
        try:
            page.locator("[role='option'], .pac-item").first.click(timeout=2500)
        except Exception:
            pass

        # 3. click search
        for name in ("Search", "Get estimate", "Continue", "Next"):
            try:
                page.get_by_role("button", name=re.compile(name, re.I)).first.click(timeout=2000)
                break
            except Exception:
                continue

        # 4. wait for a dollar amount to show up
        try:
            page.wait_for_selector("text=/\\$[\\d,]{3,}/", timeout=30000)
        except Exception:
            pass
        page.wait_for_timeout(1500)

        text = page.inner_text("body")
        if "press & hold" in text.lower() or "verify" in text.lower():
            input("CAPTCHA on screen — clear it, then press Enter... ")
            page.wait_for_timeout(2000)
            text = page.inner_text("body")

        lo, hi, median = read_rent(text)

        if median:
            span = f" (range ${lo:,}–${hi:,})" if lo else ""
            print(f"\n{address}\nMedian rent: ${median:,}/mo{span}")
        else:
            page.screenshot(path="rent_fail.png", full_page=True)
            print("\nNo rent found. Screenshot saved to rent_fail.png")

        input("\nEnter to close...")
        browser.close()


if __name__ == "__main__":
    main()
