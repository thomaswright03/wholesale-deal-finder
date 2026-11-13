#!/usr/bin/env python3
"""
Pull listing photos for every house in photos/needed.json that still needs them.

    python3 photos.py
    python3 photos.py --once "238 Helen St, Cincinnati, OH 45219"
    python3 photos.py --repo ~/repos/wholesale-deal-finder

Reads photos/needed.json, skips anything with hasPhotos true, saves into the entry's
folder, then commits and pushes. Max 10 files per house, 5 MB each, min 5 to keep.
"""
import argparse
import json
import os
import pathlib
import random
import re
import shutil
import subprocess
import sys
import time
from collections import defaultdict

import requests
import undetected_chromedriver as uc
from selenium.common.exceptions import WebDriverException
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")

MAX_FILES = 10
MIN_FILES = 5
MAX_BYTES = 5 * 1024 * 1024
OK_EXT = {".jpg", ".jpeg", ".png", ".webp", ".gif"}

# listing gallery JSON only — not every cdn-redfin URL on the page
PHOTOURLS = re.compile(
    r'"photoUrls"\s*:\s*\{[^}]*?"bigphoto"\s*:\s*"(https://ssl\.cdn-redfin\.com/photo/[^"]+)"',
    re.S)
BIG = re.compile(r'"(?:bigphoto|huge|largePhoto)"\s*:\s*"(https://ssl\.cdn-redfin\.com/photo/\d+/[^"]+)"')
LISTING = re.compile(r'https://ssl\.cdn-redfin\.com/photo/\d+/(?:bigphoto|huge|largePhoto)/\d+\.(?:jpg|jpeg|webp)')
LDJSON = re.compile(r'<script type="application/ld\+json">(.*?)</script>', re.S)
SET_ID = re.compile(r"/photo/(\d+)/")

SEARCH_BOXES = ["input#search-input", "input[placeholder*='address' i]",
                "input[type='search']", "input[type='text']"]
SUGGESTIONS = [".suggestion-item", "[role='option']", "li.item-row",
               "#search-input-wrapper li", ".SearchHomeContentV2 .item-row"]
CARDS = ["a[href*='/home/']", ".SearchResultCard a"]
GALLERY = ["button[data-testid='hero-photo-count']", "[data-rf-test-name*='photo']",
           "button[aria-label*='photo' i]", "a[href*='photogallery']"]

# only images inside the listing gallery / hero — not similar homes
DOM_JS = """() => {
  const roots = document.querySelectorAll(
    '[class*="MediaBrowser"], [class*="media-browser"], [class*="PhotoCarousel"],'
    + ' [class*="hero-photos"], [data-rf-test-id*="photo"], [data-rf-test-name*="photo"]'
  );
  const out = [];
  const els = roots.length
    ? [...roots].flatMap(r => [...r.querySelectorAll('img, source')])
    : [];
  for (const el of els) {
    for (const a of ['src', 'srcset', 'data-src']) {
      const v = el.getAttribute(a) || '';
      for (const piece of v.split(',')) {
        const u = piece.trim().split(' ')[0];
        if (/cdn-redfin\\.com\\/photo\\/\\d+\\/(bigphoto|huge|largePhoto)\\//.test(u))
          out.push(u);
      }
    }
  }
  return out;
}"""


# ---------------------------------------------------------------- repo

def find_repo(explicit=None):
    """Repo root: explicit flag, else nearest ancestor with .git or the queue."""
    if explicit:
        return pathlib.Path(explicit).expanduser().resolve()
    here = pathlib.Path(__file__).resolve().parent
    for d in [here, *here.parents]:
        if (d / ".git").exists() or (d / "photos" / "needed.json").exists():
            return d
    return here


REPO = find_repo()
QUEUE = REPO / "photos" / "needed.json"


# ---------------------------------------------------------------- browser

def make_driver():
    opts = uc.ChromeOptions()
    opts.add_argument("--window-size=1440,1000")
    opts.add_argument("--disable-blink-features=AutomationControlled")
    d = uc.Chrome(options=opts, use_subprocess=True)
    d.set_page_load_timeout(60)
    return d


def blocked(driver) -> bool:
    try:
        src = driver.page_source.lower()
    except WebDriverException:
        return True
    return "px-captcha" in src or "press & hold" in src


def click_first(driver, selectors, timeout=10.0):
    end = time.time() + timeout
    while time.time() < end:
        for sel in selectors:
            try:
                for el in driver.find_elements(By.CSS_SELECTOR, sel):
                    if el.is_displayed():
                        return el
            except WebDriverException:
                pass
        time.sleep(0.4)
    return None


def search_on_redfin(driver, address):
    driver.get("https://www.redfin.com/")
    time.sleep(3)
    if blocked(driver):
        input("Bot check on screen — clear it, then press Enter... ")
        time.sleep(3)

    box = click_first(driver, SEARCH_BOXES, timeout=15)
    if box is None:
        return None
    driver.execute_script("arguments[0].scrollIntoView({block:'center'})", box)
    box.click()
    box.send_keys(address)
    time.sleep(2.0)

    sug = click_first(driver, SUGGESTIONS, timeout=8)
    if sug is not None:
        driver.execute_script("arguments[0].click()", sug)
    else:
        box.send_keys(Keys.ENTER)
    time.sleep(3)

    if "/home/" not in (driver.current_url or ""):
        card = click_first(driver, CARDS, timeout=10)
        if card is not None:
            driver.execute_script("arguments[0].click()", card)
            time.sleep(3)

    return driver.current_url if "/home/" in (driver.current_url or "") else None


# ---------------------------------------------------------------- extract

def normalize(url):
    u = url.split("?")[0]
    return re.sub(r"/(?:bigphoto|largePhoto|mbp|huge|smallPhoto|genMid|islrg)/",
                  "/bigphoto/", u)


def photo_key(url):
    m = re.search(r"/photo/(\d+)/[^/]+/(\d+)\.", url)
    return f"{m.group(1)}-{m.group(2)}" if m else url[-40:]


def listing_only(urls):
    """Keep the largest /photo/{id}/ cluster — that's this listing, not comps."""
    groups = defaultdict(list)
    for u in urls:
        m = SET_ID.search(u)
        if not m:
            continue
        groups[m.group(1)].append(u)
    if not groups:
        return []
    return max(groups.values(), key=len)


def extract(html, dom):
    found = list(dom) + PHOTOURLS.findall(html) + BIG.findall(html)

    for blob in LDJSON.findall(html):
        try:
            data = json.loads(blob)
        except json.JSONDecodeError:
            continue
        for node in (data if isinstance(data, list) else [data]):
            if not isinstance(node, dict):
                continue
            # only the listing's own schema, not related listings
            types = node.get("@type") or ""
            if isinstance(types, list):
                types = " ".join(types)
            if types and "RealEstateListing" not in types and "Residence" not in types:
                continue
            imgs = node.get("image")
            if isinstance(imgs, list):
                found.extend(i for i in imgs if isinstance(i, str) and LISTING.search(i))
            elif isinstance(imgs, str) and LISTING.search(imgs):
                found.append(imgs)

    out, seen = [], set()
    for u in found:
        u = normalize(u)
        if not LISTING.search(u):
            continue
        k = photo_key(u)
        if k in seen:
            continue
        seen.add(k)
        out.append(u)

    return listing_only(out)


def harvest(driver, url, cap):
    """Open a listing, walk the gallery, return up to `cap` CDN urls."""
    driver.get(url)
    time.sleep(3)
    if blocked(driver):
        input("Bot check on screen — clear it, then press Enter... ")
        time.sleep(3)

    for _ in range(6):
        driver.execute_script("window.scrollBy(0, 900)")
        time.sleep(random.uniform(0.5, 1.0))
    driver.execute_script("window.scrollTo(0, 0)")

    for sel in GALLERY:
        try:
            driver.execute_script("arguments[0].click()",
                                  driver.find_element(By.CSS_SELECTOR, sel))
            time.sleep(2)
            break
        except Exception:
            continue

    for _ in range(4):
        driver.execute_script(
            "document.querySelectorAll(\"button[aria-label*='ext' i],"
            " [class*='next']\").forEach(b => b.click())")
        time.sleep(1.0)

    dom = driver.execute_script(DOM_JS) or []
    return extract(driver.page_source, dom)[:cap]


# ---------------------------------------------------------------- download

def download(urls, folder, delay):
    """Save into folder as 01, 02, ... Skipping oversize or broken files."""
    folder.mkdir(parents=True, exist_ok=True)
    s = requests.Session()
    s.headers.update({"user-agent": UA, "referer": "https://www.redfin.com/"})
    saved = 0

    for url in urls:
        if saved >= MAX_FILES:
            break
        ext = os.path.splitext(url.split("?")[0])[1].lower()
        if ext not in OK_EXT:
            ext = ".jpg"
        try:
            r = s.get(url, timeout=45)
        except requests.RequestException as e:
            print(f"    fail: {e}")
            continue
        if r.status_code != 200 or len(r.content) < 5000:
            print(f"    skip ({r.status_code})")
            continue
        if len(r.content) > MAX_BYTES:
            print(f"    skip ({len(r.content) // 1024}kb, over 5 MB)")
            continue

        saved += 1
        path = folder / f"{saved:02d}{ext}"
        path.write_bytes(r.content)
        print(f"    {path.name} {len(r.content) // 1024}kb")
        time.sleep(random.uniform(delay, delay + 0.6))

    return saved


# ---------------------------------------------------------------- git

def git(*args):
    return subprocess.run(["git", *args], cwd=REPO, capture_output=True, text=True)


def sync(message):
    git("add", "photos")
    commit = git("commit", "-m", message)
    if commit.returncode != 0:
        print(f"  nothing to commit ({commit.stdout.strip() or commit.stderr.strip()})")
        return
    push = git("push")
    print("  pushed" if push.returncode == 0 else f"  push failed: {push.stderr.strip()}")


# ---------------------------------------------------------------- run

def load_queue():
    if not QUEUE.exists():
        sys.exit(f"missing {QUEUE} — wrong directory? try --repo <path>")

    data = json.loads(QUEUE.read_text())

    if isinstance(data, dict):
        for key in ("houses", "addresses", "leads", "items", "queue"):
            if isinstance(data.get(key), list):
                data = data[key]
                break
        else:
            data = [v for v in data.values() if isinstance(v, dict)]

    out = []
    for entry in data if isinstance(data, list) else []:
        if isinstance(entry, str):
            entry = {"address": entry}
        if not isinstance(entry, dict) or entry.get("hasPhotos"):
            continue

        address = (entry.get("address") or entry.get("fullAddress")
                   or entry.get("addr") or "").strip()
        if not address:
            continue

        if not entry.get("folder"):
            slug = re.sub(r"[^A-Za-z0-9]+", "-", address).strip("-")
            entry["folder"] = f"photos/{slug}"
        out.append(entry)

    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--once", help="single address, ignores the queue")
    ap.add_argument("--repo", help="path to the repo root")
    ap.add_argument("--delay", type=float, default=0.4)
    ap.add_argument("--no-push", action="store_true")
    a = ap.parse_args()

    global REPO, QUEUE
    if a.repo:
        REPO = find_repo(a.repo)
        QUEUE = REPO / "photos" / "needed.json"
    print(f"repo: {REPO}")

    if a.once:
        target = a.once
        folder = REPO / "photos" / re.sub(r"[^A-Za-z0-9]+", "-", target).strip("-")
        queue = [{"address": target, "folder": str(folder.relative_to(REPO))}]
    else:
        pull = git("pull", "--rebase", "--autostash")
        if pull.returncode != 0:
            print(f"  pull failed, continuing on local copy: {pull.stderr.strip()}")
        queue = load_queue()
        if not queue:
            print("nothing flagged hasPhotos: false")
            return

    print(f"{len(queue)} house(s) to pull\n")
    driver = make_driver()
    done, skipped, failed = [], [], []

    try:
        for i, entry in enumerate(queue, 1):
            address = entry["address"]
            raw = entry.get("folder")
            if not raw:
                print(f"[{i}/{len(queue)}] {address}\n    no folder value, skipping")
                failed.append(address)
                continue
            if not raw.startswith("photos/"):
                raw = "photos/" + raw.lstrip("/")
            folder = REPO / raw
            print(f"[{i}/{len(queue)}] {address}")

            urls = []
            for attempt in (1, 2):
                try:
                    listing = search_on_redfin(driver, address)
                    if not listing:
                        print("    no listing found")
                        break
                    print(f"    {listing}")
                    urls = harvest(driver, listing, MAX_FILES)
                    break
                except WebDriverException as e:
                    print(f"    browser died ({e.__class__.__name__}), retry {attempt}")
                    try:
                        driver.quit()
                    except Exception:
                        pass
                    time.sleep(3)
                    driver = make_driver()

            if len(urls) < MIN_FILES:
                print(f"    only {len(urls)} listing photo(s) — under {MIN_FILES}, skipping")
                failed.append(address)
                continue

            got = download(urls[:MAX_FILES], folder, a.delay)
            if got < MIN_FILES:
                print(f"    {got} saved — under {MIN_FILES}, dropping folder")
                shutil.rmtree(folder, ignore_errors=True)
                skipped.append(address)
                continue

            done.append(address)
    finally:
        try:
            driver.quit()
        except Exception:
            pass

    print(f"\nsaved {len(done)} · skipped {len(skipped)} · failed {len(failed)}")
    if done and not a.no_push:
        sync(f"photos: add {len(done)} house(s)")


if __name__ == "__main__":
    main()
