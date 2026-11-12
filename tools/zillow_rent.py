#!/usr/bin/env python3
"""
zillow_rent.py — get a rent estimate for an address from Zillow's rental manager.

    python zillow_rent.py --once "6823 Betts Ave, Cincinnati, OH 45239"
    python zillow_rent.py --csv addresses.csv --out rents.csv

Three routes, tried in order:
  1. the tool's JSON endpoint          (cheap, no browser)
  2. the price-my-rental page in a browser
  3. the property page's rent Zestimate

Setup:  pip install requests playwright
        Uses your installed Google Chrome (--channel chrome, the default).
        Pass --channel chromium to use Playwright's own Chromium instead
        (needs `playwright install chromium`).
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import random
import re
import sqlite3
import sys
import time
import urllib.parse
from dataclasses import dataclass, field

import requests

TOOL_URL = "https://www.zillow.com/rental-manager/price-my-rental/"
API_URLS = [
    "https://www.zillow.com/rental-manager/api/price-my-rental/",
    "https://www.zillow.com/rental-manager/price-my-rental/api/estimate/",
]
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
DB = "rent_cache.sqlite"
TTL_DAYS = 30

RANGE_RE = re.compile(r"\$\s?([\d,]{3,7})\s*(?:-|–|—|to)\s*\$\s?([\d,]{3,7})")
DOLLAR_RE = re.compile(r"\$\s?([\d,]{3,7})")
ZEST_RE = re.compile(r'"rentZestimate"\s*:\s*(\d+)')
ZEST_LO = re.compile(r'"rentZestimateLow(?:Price)?"\s*:\s*(\d+)')
ZEST_HI = re.compile(r'"rentZestimateHigh(?:Price)?"\s*:\s*(\d+)')
CAPTCHA = ("press & hold", "verify you are human", "please verify", "px-captcha")


# ---------------------------------------------------------------- result

@dataclass
class Rent:
    address: str
    rent: int | None = None
    low: int | None = None
    high: int | None = None
    source: str = ""
    note: str = ""
    candidates: list[int] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return self.rent is not None

    def row(self) -> dict:
        # "lookup_address" so the input CSV's own address column is kept as-is
        return {"lookup_address": self.address, "rent": self.rent or "", "low": self.low or "",
                "high": self.high or "", "source": self.source, "note": self.note}


# ---------------------------------------------------------------- cache

def db() -> sqlite3.Connection:
    c = sqlite3.connect(DB)
    c.execute("""CREATE TABLE IF NOT EXISTS rent(
                   k TEXT PRIMARY KEY, address TEXT, rent INTEGER, low INTEGER,
                   high INTEGER, source TEXT, ts REAL)""")
    return c


def key(address: str) -> str:
    return hashlib.sha1(re.sub(r"\s+", " ", address.lower()).strip().encode()).hexdigest()


def cache_get(address: str) -> Rent | None:
    with db() as c:
        row = c.execute("SELECT rent,low,high,source,ts FROM rent WHERE k=?",
                        (key(address),)).fetchone()
    if not row:
        return None
    if (time.time() - row[4]) / 86400 > TTL_DAYS:
        return None
    return Rent(address, row[0], row[1], row[2], row[3] + " (cached)")


def cache_put(r: Rent) -> None:
    with db() as c:
        c.execute("INSERT OR REPLACE INTO rent VALUES(?,?,?,?,?,?,?)",
                  (key(r.address), r.address, r.rent, r.low, r.high, r.source, time.time()))


# ---------------------------------------------------------------- parsing

def numbers(text: str, lo: int = 350, hi: int = 20000) -> list[int]:
    out = []
    for m in DOLLAR_RE.finditer(text):
        n = int(m.group(1).replace(",", ""))
        if lo <= n <= hi:
            out.append(n)
    return out


def parse_estimate(text: str) -> Rent | None:
    """Read a rent off rendered page text. Range beats a lone number."""
    rng = RANGE_RE.search(text)
    if rng:
        lo = int(rng.group(1).replace(",", ""))
        hi = int(rng.group(2).replace(",", ""))
        if 350 <= lo < hi <= 20000:
            return Rent("", (lo + hi) // 2, lo, hi, "tool", "range")
    vals = sorted(numbers(text))
    if not vals:
        return None
    # the estimate usually repeats; the mode of the candidate list is the answer
    mode = max(set(vals), key=vals.count)
    return Rent("", mode, None, None, "tool", f"mode of {len(vals)} (low confidence)")


# ---------------------------------------------------------------- route 1: json

def via_api(address: str, beds: int | None, baths: float | None,
            s: requests.Session) -> Rent | None:
    body = {"address": address}
    if beds:
        body["beds"] = beds
    if baths:
        body["baths"] = baths
    for url in API_URLS:
        try:
            r = s.post(url, json=body, timeout=25, headers={
                "user-agent": UA, "content-type": "application/json",
                "referer": TOOL_URL, "accept": "application/json, text/plain, */*"})
        except requests.RequestException:
            continue
        if r.status_code != 200:
            continue
        try:
            j = r.json()
        except ValueError:
            continue
        rent = (j.get("rent") or j.get("estimate") or j.get("rentEstimate")
                or (j.get("data") or {}).get("rent"))
        if isinstance(rent, str):
            rent = re.sub(r"\D", "", rent) or None
        if rent:
            rent = int(rent)
            lo = j.get("low") or j.get("rentLow")
            hi = j.get("high") or j.get("rentHigh")
            return Rent(address, rent, lo, hi, "api", "json endpoint")
    return None


# ---------------------------------------------------------------- route 2/3: browser

def first(page, selectors: list[str]):
    for sel in selectors:
        try:
            loc = page.locator(sel).first
            if loc.count():
                return loc
        except Exception:
            continue
    return None


def blocked(page) -> bool:
    try:
        body = page.inner_text("body")[:4000].lower()
    except Exception:
        return False
    return any(t in body for t in CAPTCHA)


def via_tool_page(page, address: str, beds: int | None, baths: float | None) -> Rent | None:
    page.goto(TOOL_URL, wait_until="domcontentloaded", timeout=45000)
    page.wait_for_timeout(random.randint(900, 1800))

    inp = first(page, ["input[name='address']", "input#address",
                       "input[placeholder*='address' i]", "input[type='text']"])
    if not inp:
        return None
    inp.click()
    inp.fill(address)
    page.wait_for_timeout(random.randint(1100, 2000))

    sug = first(page, ["[role='option']", ".pac-item", "li[role='option']",
                       "ul[role='listbox'] li"])
    if sug:
        try:
            sug.click()
        except Exception:
            pass
    page.wait_for_timeout(random.randint(700, 1400))

    if beds:
        sel = first(page, ["select[name='beds']", "select#beds"])
        if sel:
            try:
                sel.select_option(str(beds))
            except Exception:
                pass
    if baths:
        sel = first(page, ["select[name='baths']", "select#baths"])
        if sel:
            try:
                sel.select_option(str(baths))
            except Exception:
                pass

    btn = first(page, ["button[type='submit']", "button:has-text('Get estimate')",
                       "button:has-text('Continue')", "button:has-text('Next')"])
    if btn:
        try:
            btn.click()
        except Exception:
            pass

    try:
        page.wait_for_selector("text=/\\$[\\d,]+/", timeout=25000)
    except Exception:
        pass
    page.wait_for_timeout(1500)

    if blocked(page):
        return None
    got = parse_estimate(page.inner_text("body"))
    if got:
        got.address = address
    return got


def via_property_page(page, address: str) -> Rent | None:
    slug = re.sub(r"[,\s]+", "-", address.strip()).replace("--", "-")
    page.goto(f"https://www.zillow.com/homes/{slug}_rb/", wait_until="domcontentloaded",
              timeout=45000)
    page.wait_for_timeout(random.randint(1200, 2200))
    if blocked(page):
        return None
    html = page.content()
    m = ZEST_RE.search(html)
    if not m:
        return None
    lo = ZEST_LO.search(html)
    hi = ZEST_HI.search(html)
    return Rent(address, int(m.group(1)), int(lo.group(1)) if lo else None,
                int(hi.group(1)) if hi else None, "zestimate", "property page")


# ---------------------------------------------------------------- resolve

def resolve(address: str, beds=None, baths=None, headed=False, profile=None,
            use_cache=True, channel="chrome") -> Rent:
    if use_cache:
        hit = cache_get(address)
        if hit:
            return hit

    s = requests.Session()
    s.headers.update({"user-agent": UA, "accept-language": "en-US,en;q=0.9"})

    try:
        got = via_api(address, beds, baths, s)
        if got:
            got.address = address
            cache_put(got)
            return got
    except Exception as e:
        print(f"  api route failed: {e}")

    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            profile or ".zillow-profile", headless=not headed,
            channel=None if channel == "chromium" else channel,
            user_agent=UA, viewport={"width": 1366, "height": 900},
            locale="en-US")
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        out = None
        try:
            out = via_tool_page(page, address, beds, baths)
        except Exception as e:
            print(f"  tool page failed: {e}")
        if not out:
            try:
                out = via_property_page(page, address)
            except Exception as e:
                print(f"  property page failed: {e}")
        ctx.close()

    out = out or Rent(address, note="no estimate found")
    if out.ok:
        cache_put(out)
    return out


# ---------------------------------------------------------------- cli

def one(address: str, a) -> None:
    print(f"→ {address}")
    r = resolve(address, a.beds, a.baths, a.headed, a.profile, not a.no_cache, a.channel)
    if r.ok:
        rng = f" (range {r.low}-{r.high})" if r.low and r.high else ""
        print(f"  ${r.rent:,}/mo{rng}  [{r.source}] {r.note}")
    else:
        print(f"  FAILED — {r.note or 'blocked or unparsed'}")
        if a.headed:
            input("  solve it in the window, then press Enter to retry... ")
            r2 = resolve(address, a.beds, a.baths, True, a.profile, False, a.channel)
            print(f"  {'$' + format(r2.rent, ',') + '/mo' if r2.ok else 'still failed'}")


def batch(a) -> None:
    with open(a.csv, newline="", encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))
    if not rows:
        sys.exit("empty csv")
    field_addr = a.col
    if field_addr not in rows[0]:
        sys.exit(f"no column {field_addr!r}; found {list(rows[0])}")

    results, hits = [], 0
    for i, row in enumerate(rows, 1):
        addr = " ".join(x for x in (row[field_addr], row.get("city", ""),
                                    row.get("state", ""), row.get("zip", "")) if x).strip()
        if not addr:
            continue
        beds = int(row["beds"]) if row.get("beds", "").isdigit() else None
        baths = float(row["baths"]) if row.get("baths", "").replace(".", "").isdigit() else None
        print(f"[{i}/{len(rows)}] {addr}")
        r = resolve(addr, beds, baths, a.headed, a.profile, not a.no_cache, a.channel)
        print(f"   {'$' + format(r.rent, ',') if r.ok else 'FAILED'}  [{r.source or '-'}] {r.note}")
        hits += r.ok
        results.append({**row, **r.row()})
        if i < len(rows):
            time.sleep(random.uniform(a.delay, a.delay + 2.5))

    with open(a.out, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(results[0]))
        w.writeheader()
        w.writerows(results)
    print(f"\n{hits}/{len(results)} resolved → {a.out}")


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--once")
    p.add_argument("--csv")
    p.add_argument("--col", default="address")
    p.add_argument("--out", default="rents_out.csv")
    p.add_argument("--beds", type=int)
    p.add_argument("--baths", type=float)
    p.add_argument("--headed", action="store_true", help="show the browser (helps with captchas)")
    p.add_argument("--profile", default=None, help="persistent browser profile dir")
    p.add_argument("--channel", default="chrome", help="chrome (installed Google Chrome) or chromium")
    p.add_argument("--delay", type=float, default=2.0)
    p.add_argument("--no-cache", action="store_true")
    a = p.parse_args()

    if a.once:
        one(a.once, a)
    elif a.csv:
        batch(a)
    else:
        p.print_help()


if __name__ == "__main__":
    main()
