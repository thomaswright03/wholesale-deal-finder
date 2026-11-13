
#!/usr/bin/env python3
"""
Fill rents/rents.json from Property Genie.

Collects:
  - Est. Rent (LTR): Monthly long-term rental estimate
  - Last Tax Paid: Annual property tax amount

Reads rents/needed.json and looks up every house missing
either rent or property tax information.

Usage:
  python rents/fetch_rents.py
  python rents/fetch_rents.py --push
  python rents/fetch_rents.py --dry-run
  python rents/fetch_rents.py --limit 10
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
from pathlib import Path

from playwright.sync_api import (
    sync_playwright,
    TimeoutError as PWTimeout,
)

PAGE_URL = "https://www.propertygenie.us/property-insight"

LTR_RE = re.compile(
    r"Est\.?\s*Rent\s*\(LTR\)",
    re.I,
)

TAX_RE = re.compile(
    r"Last\s+Tax\s+Paid",
    re.I,
)

MONEY_RE = re.compile(
    r"\$\s*([\d,]+(?:\.\d{2})?)"
)


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


def extract_label_value(page, pattern) -> int | None:
    """
    Finds a page label and extracts the dollar amount
    displayed next to or underneath it.
    """

    labels = page.get_by_text(pattern)

    if labels.count() == 0:
        return None

    label = labels.first

    candidates = []

    # First try the next sibling.
    try:
        sibling = label.locator(
            "xpath=following-sibling::*[1]"
        )

        if sibling.count():
            candidates.append(
                sibling.inner_text(timeout=2000)
            )
    except Exception:
        pass

    # Then try the immediate parent.
    try:
        parent = label.locator("xpath=..")

        candidates.append(
            parent.inner_text(timeout=2000)
        )
    except Exception:
        pass

    # Finally try the grandparent.
    try:
        grandparent = label.locator("xpath=../..")

        candidates.append(
            grandparent.inner_text(timeout=2000)
        )
    except Exception:
        pass

    for candidate in candidates:
        if not candidate:
            continue

        match = MONEY_RE.search(candidate)

        if match:
            amount = as_int(match.group(1))

            if amount:
                return amount

    return None


def scrape_one(page, address: str) -> dict:
    """
    Searches Property Genie for one property
    and extracts rent and property tax.
    """

    page.goto(
        PAGE_URL,
        wait_until="domcontentloaded",
        timeout=30000,
    )

    box = page.locator(
        "input[placeholder*='property address' i]"
    ).first

    box.wait_for(
        state="visible",
        timeout=15000,
    )

    box.click()
    box.fill("")
    box.type(address, delay=35)

    # Select the address suggestion.
    try:
        page.wait_for_selector(
            ".pac-item, [role='option'], [class*='suggestion']",
            timeout=7000,
        )

        suggestion = page.locator(
            ".pac-item, [role='option']"
        ).first

        suggestion.click()

    except PWTimeout:
        box.press("Enter")

    # Submit search.
    page.get_by_role(
        "button",
        name=re.compile(r"^search$", re.I),
    ).click()

    # Wait for rental estimate.
    try:
        page.wait_for_selector(
            "text=/Est\\.?\\s*Rent\\s*\\(LTR\\)/i",
            timeout=30000,
        )

    except PWTimeout:
        print("  ! Rent results did not appear.")

    # Extract rental estimate.
    rent = extract_label_value(
        page,
        LTR_RE,
    )

    # Wait briefly for the financial overview.
    try:
        page.get_by_text(
            TAX_RE
        ).first.wait_for(
            state="visible",
            timeout=10000,
        )

    except PWTimeout:
        print("  ! Last Tax Paid label not found.")

    # Extract annual property taxes.
    property_tax = extract_label_value(
        page,
        TAX_RE,
    )

    result = {}

    if rent:
        result["rent"] = rent

    if property_tax:
        result["propertyTax"] = property_tax

    return result


def scrape_all(
    houses: list[dict],
    existing: dict,
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

        for i, house in enumerate(houses, 1):

            key = house["key"]
            address = house["address"]

            print(
                f"\n[{i}/{len(houses)}] {address}"
            )

            try:
                got = scrape_one(
                    page,
                    address,
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
                    print("  ! Rent not found")

                if "propertyTax" in merged:
                    print(
                        f"  Property tax: "
                        f"${merged['propertyTax']:,}/year"
                    )
                else:
                    print("  ! Property tax not found")

                # Only save records with actual new data.
                if got:
                    out[key] = merged

            except Exception as e:
                print(f"  ! Error: {e}")

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

        if not has_rent or not has_tax:
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
