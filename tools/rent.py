#!/usr/bin/env python3
"""
Fill rents/rents.json from Property Genie (Est. Rent LTR).

Reads rents/needed.json, looks up every house with hasRent=false,
merges into rents/rents.json, optionally git push.

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

API_URL = (
    "https://propgen-prod-api-b48e01f8c03a.herokuapp.com"
    "/api/v1/public/getDefaultAddressInfo"
)
PAGE_URL = "https://www.propertygenie.us/property-insight"
LTR_RE = re.compile(r"Est\.?\s*Rent\s*\(LTR\)\s*\$?\s*([\d,]+)", re.I)
MONEY_RE = re.compile(r"\$\s*([\d,]+)")


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
        ["git", "commit", "-m", "update rents from Property Genie"],
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
    if isinstance(v, (int, float)):
        return int(round(v))
    m = re.search(r"[\d,]+", str(v))
    return int(m.group(0).replace(",", "")) if m else None


def entry(rent: int) -> dict:
    return {"rent": int(rent)}


def pick_rent(obj: dict) -> int | None:
    """Walk a Property Genie payload for rentZestimate / Est. Rent LTR."""
    if not isinstance(obj, dict):
        return None
    for key in ("rentZestimate", "rent_zestimate", "ltrRent", "monthlyRent"):
        n = as_int(obj.get(key))
        if n:
            return n
    details = obj.get("propertyDetails") or obj.get("data") or obj.get("property")
    if isinstance(details, dict):
        n = pick_rent(details)
        if n:
            return n
    return None


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
    # Public endpoint first, then the authed-looking one (sometimes open)
    for url, body in (
        (API_URL, {"address": address}),
        (
            "https://propgen-prod-api-b48e01f8c03a.herokuapp.com"
            "/api/v1/address/getPropertyDetailsByAddress",
            {"address": address},
        ),
    ):
        try:
            r = requests.post(url, json=body, headers=headers, timeout=25)
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
        rent = pick_rent(payload if isinstance(payload, dict) else {})
        if rent:
            return entry(rent)
    return None


def api_all(houses: list[dict]) -> dict:
    out = {}
    for i, h in enumerate(houses, 1):
        print(f"[{i}/{len(houses)}] {h['address']}")
        got = api_one(h["address"])
        if got:
            out[h["key"]] = got
            print(f"  rent ${got['rent']}")
        else:
            print("  ! no LTR rent from API")
        time.sleep(0.4)
    return out


# ---------------------------------------------------------------------------
# Browser scrape of property-insight (Est. Rent LTR on the results card)
# ---------------------------------------------------------------------------

def scrape_one(page, address: str) -> dict | None:
    from playwright.sync_api import TimeoutError as PWTimeout

    page.goto(PAGE_URL, wait_until="domcontentloaded")
    box = page.locator("input[placeholder*='property address' i]").first
    box.click()
    box.fill("")
    box.type(address, delay=35)

    # New Places API dropdown, or classic .pac-item
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

    # Prefer the value sitting under the LTR label
    label = page.get_by_text(re.compile(r"Est\.?\s*Rent\s*\(LTR\)", re.I)).first
    sibling = label.locator("xpath=following-sibling::*[1]")
    chunk = ""
    try:
        chunk = sibling.inner_text(timeout=3000)
    except Exception:
        pass
    if not chunk:
        chunk = label.locator("xpath=..").inner_text()

    n = as_int(chunk)
    if not n:
        m = LTR_RE.search(page.inner_text("body"))
        n = as_int(m.group(1)) if m else None
    if not n:
        print(f"  ! could not parse LTR rent from: {chunk!r}")
        return None
    return entry(n)


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
                print(f"  rent ${got['rent']}")
            time.sleep(1.2)
        browser.close()
    return out


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
    todo = [h for h in todo if h["key"] not in existing]
    if args.limit:
        todo = todo[: args.limit]
    print(f"Already have {len(existing)} rents; looking up {len(todo)} new ones")
    if not todo:
        print("Nothing to do.")
        return

    new = scrape_all(todo) if args.browser else api_all(todo)

    # If API missed some, retry those in the browser
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
