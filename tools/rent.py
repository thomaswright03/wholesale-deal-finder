
#!/usr/bin/env python3
"""
Fill rents/rents.json from Property Genie.

Collects:
  - Est. Rent (LTR): monthly long-term rent (some houses show N/A)
  - Estimate: value, when shown
  - Annual property tax, estimated from Last Tax Valuation x Property Tax Rate
    (Ohio valuations are 35% of market value, so they are scaled up first)

Reads rents/needed.json and looks up every house missing
either rent or property tax information.

Usage:
  python3 tools/rent.py
  python3 tools/rent.py --push
  python3 tools/rent.py --dry-run
  python3 tools/rent.py --limit 10
  python3 tools/rent.py --max-minutes 45   (what the daily GitHub run uses)
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
from datetime import date, timedelta
from pathlib import Path

from playwright.sync_api import (
    sync_playwright,
    TimeoutError as PWTimeout,
)

PAGE_URL = "https://www.propertygenie.us/property-insight"

# Before any search the page shows a built-in sample house
# ("3126 Valley View Dr, Arnold, CA", rent $2,436). We only read numbers
# once the address under "Property Analysis Results" is the one we searched.
RESULTS_HEADING = "Property Analysis Results"

# Ohio taxes are charged on the assessed value, which is 35% of market value.
# Property Genie's "Last Tax Valuation" is that assessed value for Ohio houses,
# and "Property Tax Rate" is the rate on market value.
ASSESSED_SHARE = {"OH": 0.35}


def find_rents_dir() -> Path:
    here = Path(__file__).resolve().parent

    for candidate in (
        here,
        here / "rents",
        here.parent / "rents",
        Path.cwd() / "rents",
    ):
        if (candidate / "needed.json").exists():
            return candidate

    sys.exit(
        "Could not find rents/needed.json. "
        "Run from the repo root."
    )


def load_needed(path: Path) -> list[dict]:
    data = json.loads(path.read_text())

    if isinstance(data, dict):
        houses = data.get("houses", [])
    elif isinstance(data, list):
        houses = data
    else:
        houses = []

    print(f"needed.json: {len(houses)} houses")

    return houses


def load_rents(path: Path) -> dict:
    if not path.exists():
        return {}

    return json.loads(path.read_text())


def save_rents(path: Path, rents: dict) -> None:
    path.write_text(
        json.dumps(rents, indent=2) + "\n"
    )

    print(f"Wrote {len(rents)} entries -> {path}")


def git_push(rents_path: Path) -> None:
    repo = rents_path.parent.parent
    rel = rents_path.relative_to(repo)

    subprocess.run(
        ["git", "add", str(rel)],
        cwd=repo,
        check=True,
    )

    result = subprocess.run(
        [
            "git",
            "commit",
            "-m",
            "update rents and property taxes from Property Genie",
        ],
        cwd=repo,
        capture_output=True,
        text=True,
    )

    output = (
        result.stdout + result.stderr
    ).lower()

    if result.returncode != 0:
        print(result.stdout + result.stderr)

        if "nothing to commit" in output:
            print("Nothing new to commit.")
            return

        sys.exit("Git commit failed.")

    subprocess.run(
        ["git", "push"],
        cwd=repo,
        check=True,
    )

    print("Pushed rents/rents.json")


def as_int(value) -> int | None:
    if value is None or value == "":
        return None

    if isinstance(value, (int, float)):
        return int(round(value))

    if str(value).upper() == "N/A":
        return None

    match = re.search(
        r"[\d,]+",
        str(value),
    )

    if not match:
        return None

    return int(
        match.group(0).replace(",", "")
    )


def results_text(page) -> str:
    """Text of the results section (address line first)."""
    text = page.inner_text("body")
    i = text.find(RESULTS_HEADING)
    return text[i + len(RESULTS_HEADING):] if i >= 0 else ""


def same_house(result_address: str, street: str) -> bool:
    """True when the result is the house we searched (number + street name)."""
    want = street.lower().split()
    got = result_address.lower().replace(",", " ").split()
    return len(want) >= 2 and got[:2] == want[:2]


def field(text: str, label: str) -> str | None:
    """Value printed under a label, e.g. 'Est. Rent (LTR)\n\n$1,450'."""
    m = re.search(re.escape(label) + r"\s*\n+\s*([^\n]+)", text)
    return m.group(1).strip() if m else None


def money(value: str | None) -> int | None:
    if not value:
        return None
    m = re.search(r"\$\s*([\d,]+)", value)
    return int(m.group(1).replace(",", "")) if m else None


def percent(value: str | None) -> float | None:
    if not value:
        return None
    m = re.search(r"([\d.]+)\s*%", value)
    return float(m.group(1)) if m else None


def scrape_one(page, house: dict) -> dict:
    """
    Searches Property Genie for one house and returns
    rent, value and an annual property-tax estimate.
    Returns {} if the page never showed this house.
    """
    address = house["address"]
    street = house.get("street") or address.split(",")[0]

    page.goto(PAGE_URL, wait_until="domcontentloaded", timeout=30000)

    box = page.locator("input[placeholder*='property address' i]").first
    try:
        box.wait_for(state="visible", timeout=20000)
    except PWTimeout:
        body = " ".join(page.inner_text("body").split())[:300] if page.locator("body").count() else ""
        raise RuntimeError(f"search box never appeared (title: {page.title()!r}; page says: {body!r})")

    # The box starts with the sample address in it, so clear it first.
    box.click()
    box.press("ControlOrMeta+a")
    box.press("Backspace")
    box.type(address, delay=35)

    # Pick the suggestion for this house.
    number = street.split()[0]
    suggestion = page.locator(
        ".pac-item, [role='option'], li"
    ).filter(has_text=re.compile(r"^\s*" + re.escape(number) + r"\b")).first
    try:
        suggestion.wait_for(state="visible", timeout=8000)
        suggestion.click()
    except PWTimeout:
        print("  ! No address suggestion; trying anyway.")

    page.get_by_role("button", name=re.compile(r"^search$", re.I)).click()

    # Wait until the results show OUR house, not the sample one.
    text = ""
    deadline = time.time() + 30
    while time.time() < deadline:
        text = results_text(page)
        first_line = text.strip().split("\n", 1)[0] if text.strip() else ""
        if same_house(first_line, street) and "Last Tax Valuation" in text:
            break
        time.sleep(0.5)
    else:
        first_line = text.strip().split("\n", 1)[0] if text.strip() else "(nothing)"
        print(f"  ! Results never showed this house (page shows: {first_line})")
        return {}

    result: dict = {}

    rent = money(field(text, "Est. Rent (LTR)"))
    if rent:
        result["rent"] = rent

    value = money(field(text, "Estimate"))
    if value:
        result["value"] = value

    valuation = money(field(text, "Last Tax Valuation"))
    rate = percent(field(text, "Property Tax Rate"))
    if valuation and rate:
        share = ASSESSED_SHARE.get(str(house.get("state", "")).upper(), 1.0)
        market = valuation / share
        result["propertyTax"] = int(round(market * rate / 100))
        result["taxValuation"] = valuation
        result["taxRate"] = rate

    return result


def hud_rent(house: dict) -> int | None:
    """The HUD backup rent the scan will use (reference/hud-safmr-*.json). Display only."""
    ref = Path(__file__).resolve().parent.parent / "reference"
    files = sorted(ref.glob("hud-safmr-*.json"))
    if not files:
        return None
    row = json.loads(files[-1].read_text())["zips"].get(str(house.get("zip", ""))[:5])
    if not row:
        return None
    # Multi-family: the scan assumes a duplex of two 2-bedroom units.
    if "multi" in str(house.get("propertyType", "")).lower():
        return 2 * row[2]
    beds = house.get("beds")
    beds = 3 if beds is None else max(0, min(4, round(beds)))
    return row[beds]


def scrape_all(
    houses: list[dict],
    existing: dict,
    max_minutes: float = 0,
) -> dict:
    """
    Scrapes all houses and merges newly collected
    information with existing records.
    """

    out = {}

    with sync_playwright() as p:

        browser = p.chromium.launch(
            headless=True
        )

        page = browser.new_page()

        started = time.time()
        failures = 0
        for i, house in enumerate(houses, 1):
            if max_minutes and time.time() - started > max_minutes * 60:
                print(f"\nTime limit ({max_minutes:g} min) reached; the rest go next run.")
                break

            key = house["key"]
            address = house["address"]

            print(
                f"\n[{i}/{len(houses)}] {address}"
            )

            try:
                got = scrape_one(
                    page,
                    house,
                )

                # Preserve existing values.
                previous = existing.get(key, {})

                merged = {
                    **previous,
                    **got,
                }

                if "rent" in merged:
                    print(
                        f"  Rent: ${merged['rent']:,}/month"
                    )
                else:
                    hud = hud_rent(house)
                    if hud:
                        print(f"  Rent: not on Property Genie -> scan will use HUD ${hud:,}/month")
                    else:
                        print("  ! Rent not found (no HUD rent either)")

                if "propertyTax" in merged:
                    print(
                        f"  Property tax: "
                        f"${merged['propertyTax']:,}/year"
                    )
                else:
                    print("  ! Property tax not found")

                # Remember we looked, so a house with no data isn't retried every day.
                merged["checked"] = date.today().isoformat()
                out[key] = merged

            except Exception as e:
                print(f"  ! Error: {str(e).splitlines()[0]}")
                failures += 1
                if failures >= 3 and not out:
                    print("\nThe site isn't loading for this computer; stopping. Nothing saved for these houses.")
                    break
                continue
            failures = 0

            time.sleep(1.2)

        browser.close()

    return out


def main():
    parser = argparse.ArgumentParser()

    parser.add_argument(
        "--push",
        action="store_true",
        help="Commit and push updated JSON to GitHub",
    )

    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Fetch data without saving",
    )

    parser.add_argument(
        "--max-minutes",
        type=float,
        default=0,
        help="Stop after this many minutes (the rest are done next run)",
    )

    parser.add_argument(
        "--recheck-days",
        type=int,
        default=30,
        help="Look a house up again after this many days if it is still missing rent",
    )

    parser.add_argument(
        "--limit",
        type=int,
        default=0,
        help="Maximum number of properties to process",
    )

    args = parser.parse_args()

    rents_dir = find_rents_dir()

    needed_path = rents_dir / "needed.json"
    rents_path = rents_dir / "rents.json"

    houses = load_needed(needed_path)
    existing = load_rents(rents_path)

    # Only process properties missing rent OR tax.
    todo = []

    for house in houses:

        key = house["key"]

        current = existing.get(key, {})

        has_rent = bool(current.get("rent"))
        has_tax = bool(current.get("propertyTax"))
        checked = current.get("checked", "")
        recent = checked >= (date.today() - timedelta(days=args.recheck_days)).isoformat()

        # Property Genie has no rent for most houses (the scan uses HUD then), so once
        # a house is checked it waits --recheck-days before another try.
        if (not has_rent or not has_tax) and not recent:
            todo.append(house)

    if args.limit:
        todo = todo[:args.limit]

    print(
        f"\nAlready have {len(existing)} records."
    )

    print(
        f"Looking up {len(todo)} properties."
    )

    if not todo:
        print("Nothing to do.")
        return

    # Browser-only scraping.
    new = scrape_all(
        todo,
        existing,
        args.max_minutes,
    )

    # Merge records without destroying existing data.
    merged = {
        **existing,
        **new,
    }

    print("\n" + "=" * 50)

    for key, value in new.items():
        print(f"{key}: {value}")

    print("=" * 50)

    complete = sum(
        1
        for house in houses
        if (
            merged.get(house["key"], {}).get("rent")
            and merged.get(house["key"], {}).get("propertyTax")
        )
    )

    print(
        f"Updated: {len(new)}"
    )

    print(
        f"Complete records: {complete}/{len(houses)}"
    )

    print(
        f"Total records in file: {len(merged)}"
    )

    if args.dry_run:
        print(
            "\nDry run — not writing rents.json."
        )
        return

    save_rents(
        rents_path,
        merged,
    )

    if args.push:
        git_push(rents_path)


if __name__ == "__main__":
    main()
