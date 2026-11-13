#!/usr/bin/env python3
"""
Fill rents/rents.json from Property Genie.

Looks up Est. Rent (LTR) and last paid property tax (lastTaxPaid)
for every house in rents/needed.json with hasRent=false.

  python rents/fetch_rents.py
  python rents/fetch_rents.py --push
  python rents/fetch_rents.py --browser     # force Playwright scrape
  python rents/fetch_rents.py --dry-run
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
from pathlib import Path

API_PUBLIC = (
    "https://propgen-prod-api-b48e01f8c03a.herokuapp.com"
    "/api/v1/public/getDefaultAddressInfo"
)
API_AUTHED = (
    "https://propgen-prod-api-b48e01f8c03a.herokuapp.com"
    "/api/v1/address/getPropertyDetailsByAddress"
)
PAGE_URL = "https://www.propertygenie.us/property-insight"
LTR_RE = re.compile(r"Est\.?\s*Rent\s*\(LTR\)\s*\$?\s*([\d,]+)", re.I)


def find_rents_dir() -> Path:
    here = Path(__file__).resolve().parent
    for c in (here, here / "rents", here.parent / "rents", Path.cwd() / "rents"):
        if (c / "needed.json").exists():
            return c
    sys.exit("Could not find rents/needed.json. Run from the repo root.")


def load_needed(path: Path) -> list[dict]:
    data = json.loads(path.read_text())
    houses = data.get("houses", data if isinstance(data, list) else [])
    todo = [h for h in houses if not h.get("hasRent")]
    print(f"needed.json: {len(houses)} houses, {len(todo)} need rent")
    return todo


def load_rents(path: Path) -> dict:
    if not path.exists():
        return {}
    return json.loads(path.read_text())


def save_rents(path: Path, rents: dict) -> None:
    path.write_text(json.dumps(rents, indent=2) + "\n")
    print(f"Wrote {len(rents)} entries -> {path}")


def git_push(rents_path: Path) -> None:
    repo = rents_path.parent.parent
    rel = rents_path.relative_to(repo)
    subprocess.run(["git", "add", str(rel)], cwd=repo, check=True)
    r = subprocess.run(
        ["git", "commit", "-m", "update rents and taxes from Property Genie"],
        cwd=repo, capture_output=True, text=True,
    )
    out = (r.stdout + r.stderr).lower()
    if r.returncode != 0:
        print(r.stdout + r.stderr)
        if "nothing to commit" in out:
            print("Nothing new to commit.")
            return
        sys.exit("git commit failed")
    subprocess.run(["git", "push"], cwd=repo, check=True)
    print("Pushed rents/rents.json")


def as_int(v) -> int | None:
    if v is None or v == "" or str(v).upper() == "N/A":
        return None
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return int(round(v))
    m = re.search(r"[\d,]+\.?\d*", str(v).replace(",", ""))
    if not m:
        return None
    try:
        return int(round(float(m.group(0))))
    except ValueError:
        return None


def unwrap_details(payload) -> dict:
    """Pull the propertyDetails / data object out of a Genie response."""
    if not isinstance(payload, dict):
        return {}
    d = payload
    for _ in range(5):
        if any(k in d for k in ("rentZestimate", "lastTaxPaid", "zpid")):
            return d
        nxt = d.get("propertyDetails") or d.get("data") or d.get("property")
        if isinstance(nxt, dict):
            d = nxt
            continue
        break
    return d if isinstance(d, dict) else {}


def entry_from_details(details: dict, rent_override: int | None = None) -> dict | None:
    rent = rent_override or as_int(
        details.get("rentZestimate")
        or details.get("rent_zestimate")
        or details.get("ltrRent")
        or details.get("monthlyRent")
    )
    if not rent:
        return None
    out = {"rent": int(rent)}
    tax = as_int(details.get("lastTaxPaid"))
    if tax is not None:
        out["tax"] = tax  # last paid property tax, annual dollars
    date = details.get("lastTaxPaidDate")
    if date:
        out["taxPaidDate"] = str(date)
    return out


def log_entry(got: dict) -> None:
    extra = f"  tax ${got['tax']}" if "tax" in got else "  tax —"
    print(f"  rent ${got['rent']}{extra}")


# ---------------------------------------------------------------------------
# Fast path: same API the website uses (no browser)
# ---------------------------------------------------------------------------

def api_one(address: str) -> dict | None:
    import requests

    headers = {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "Origin": "https://www.propertygenie.us",
        "Referer": "https://www.propertygenie.us/property-insight",
        "User-Agent": "Mozilla/5.0",
    }
    for url in (API_PUBLIC, API_AUTHED):
        try:
            r = requests.post(url, json={"address": address}, headers=headers, timeout=25)
        except requests.RequestException as e:
            print(f"  ! {e}")
            continue
        if r.status_code != 200:
            continue
        try:
            data = r.json()
        except ValueError:
            continue
        payload = data.get("data", data) if isinstance(data, dict) else data
        got = entry_from_details(unwrap_details(payload if isinstance(payload, dict) else {}))
        if got:
            return got
    return None


def api_all(houses: list[dict]) -> dict:
    out = {}
    for i, h in enumerate(houses, 1):
        print(f"[{i}/{len(houses)}] {h['address']}")
        got = api_one(h["address"])
        if got:
            out[h["key"]] = got
            log_entry(got)
        else:
            print("  ! no LTR rent from API")
        time.sleep(0.4)
    return out


# ---------------------------------------------------------------------------
# Browser scrape of property-insight
# ---------------------------------------------------------------------------

def scrape_one(page, address: str) -> dict | None:
    from playwright.sync_api import TimeoutError as PWTimeout

    captured: dict = {}

    def on_response(resp):
        url = resp.url
        if "getDefaultAddressInfo" not in url and "getPropertyDetailsByAddress" not in url:
            return
        try:
            captured["json"] = resp.json()
        except Exception:
            pass

    page.on("response", on_response)
    try:
        page.goto(PAGE_URL, wait_until="domcontentloaded")
        box = page.locator("input[placeholder*='property address' i]").first
        box.click()
        box.fill("")
        box.type(address, delay=35)

        try:
            page.wait_for_selector(
                ".pac-item, [role='option'], [class*='suggestion']",
                timeout=7000,
            )
            page.locator(".pac-item, [role='option']").first.click()
        except PWTimeout:
            box.press("Enter")

        page.get_by_role("button", name=re.compile(r"^search$", re.I)).click()

        try:
            page.wait_for_selector("text=/Est\\.?\\s*Rent\\s*\\(LTR\\)/i", timeout=30000)
        except PWTimeout:
            print("  ! results never showed Est. Rent (LTR)")
            return None

        label = page.get_by_text(re.compile(r"Est\.?\s*Rent\s*\(LTR\)", re.I)).first
        sibling = label.locator("xpath=following-sibling::*[1]")
        chunk = ""
        try:
            chunk = sibling.inner_text(timeout=3000)
        except Exception:
            pass
        if not chunk:
            chunk = label.locator("xpath=..").inner_text()

        rent = as_int(chunk)
        if not rent:
            m = LTR_RE.search(page.inner_text("body"))
            rent = as_int(m.group(1)) if m else None

        details = {}
        raw = captured.get("json")
        if isinstance(raw, dict):
            details = unwrap_details(raw.get("data", raw))

        got = entry_from_details(details, rent_override=rent)
        if got:
            return got
        if rent:
            return {"rent": int(rent)}
        print(f"  ! could not parse LTR rent from: {chunk!r}")
        return None
    finally:
        page.remove_listener("response", on_response)


def scrape_all(houses: list[dict]) -> dict:
    from playwright.sync_api import sync_playwright

    out = {}
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        for i, h in enumerate(houses, 1):
            print(f"[{i}/{len(houses)}] {h['address']}")
            try:
                got = scrape_one(page, h["address"])
            except Exception as e:
                print(f"  ! error: {e}")
                got = None
            if got:
                out[h["key"]] = got
                log_entry(got)
            time.sleep(1.2)
        browser.close()
    return out


def needs_lookup(house: dict, existing: dict) -> bool:
    prev = existing.get(house["key"])
    if not prev:
        return True
    # Backfill last paid tax if an older row only has rent
    return prev.get("tax") is None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--browser", action="store_true",
                        help="scrape the Property Insight page instead of the API")
    parser.add_argument("--push", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--limit", type=int, default=0)
    args = parser.parse_args()

    rents_dir = find_rents_dir()
    needed_path = rents_dir / "needed.json"
    rents_path = rents_dir / "rents.json"

    todo = load_needed(needed_path)
    existing = load_rents(rents_path)
    todo = [h for h in todo if needs_lookup(h, existing)]
    if args.limit:
        todo = todo[: args.limit]
    print(f"Already have {len(existing)} rents; looking up {len(todo)} new ones")
    if not todo:
        print("Nothing to do.")
        return

    new = scrape_all(todo) if args.browser else api_all(todo)

    missed = [h for h in todo if h["key"] not in new]
    if missed and not args.browser:
        print(f"\nAPI missed {len(missed)}; retrying in browser…")
        new.update(scrape_all(missed))

    merged = {**existing, **new}
    print("\n" + "=" * 50)
    for k, v in new.items():
        print(f"{k}: {v}")
    print("=" * 50)
    print(f"New: {len(new)}  Failed: {len(todo) - len(new)}  Total file: {len(merged)}")

    if args.dry_run:
        print("Dry run — not writing rents.json")
        return

    save_rents(rents_path, merged)
    if args.push:
        git_push(rents_path)


if __name__ == "__main__":
    main()
