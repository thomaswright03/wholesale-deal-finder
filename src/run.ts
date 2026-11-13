// Daily run: pull listings for each market, get rent + taxes, run the deal math,
// write a spreadsheet and a card page of the leads that work.
//
//   node src/run.ts                      all markets in config.json (needs RENTCAST_API_KEY)
//   node src/run.ts --market "Dayton, OH"  one market
//   node src/run.ts --csv listings.csv     use a CSV instead of RentCast
//   node src/run.ts --limit 0              no RentCast calls: reuse the last scan's listings
//                                          (e.g. to rate newly added photos)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { analyze, dealType, flipProfit, type BuyerAssumptions, type DealResult, type FlipAssumptions, type OfferRules } from "./deal.ts";
import { loadCsv } from "./sources/csv.ts";
import { fetchListings, fetchRent, fetchTaxAndHoa, fetchValue } from "./sources/rentcast.ts";
import type { Listing } from "./sources/types.ts";
import { writeCards, writeSpreadsheet } from "./output.ts";
import Anthropic from "@anthropic-ai/sdk";
import { conditionLabel, listPhotos, photoFolderName, photoSetKey, rateHouse, type ConditionRating, type PhotoConfig } from "./photos.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// Photos live in the repo so GitHub runs can see them: photos/<address-with-dashes>/
export const PHOTOS_DIR = "photos";
// Listings from the latest RentCast scan (kept in the Actions cache), reused when a run makes no calls.
const LAST_SCAN = join("data", "listings.json");
// Committed copy of the first real scan, used only until data/listings.json exists.
const SEED_SCAN = join("seed", "listings.json");

// Rent from your own script. rents/needed.json lists what to look up; rents/rents.json is what comes back:
//   { "238-Helen-St-Cincinnati-OH-45219": { "rent": 3300, "low": 3000, "high": 3600 }, ... }
const RENTS_DIR = "rents";
type RentEntry = { rent: number; low?: number; high?: number; source?: string; date?: string };
const rentKey = (l: Listing) => photoFolderName(l);

function loadRentFile(): Record<string, RentEntry> {
  const p = join(ROOT, RENTS_DIR, "rents.json");
  if (!existsSync(p)) return {};
  const raw = JSON.parse(readFileSync(p, "utf8"));
  const out: Record<string, RentEntry> = {};
  for (const [k, v] of Object.entries<any>(raw)) {
    const rent = Number(typeof v === "number" ? v : v?.rent);
    if (rent > 0) out[k] = typeof v === "number" ? { rent } : { ...v, rent };
  }
  console.log(`Rents from your script (rents/rents.json): ${Object.keys(out).length}`);
  return out;
}

function applyFileRent(l: Listing, rents: Record<string, RentEntry>) {
  const r = rents[rentKey(l)];
  if (!r) return;
  l.monthlyRent = r.rent;
  l.rentLow = r.low ?? r.rent;
  l.rentHigh = r.high ?? r.rent;
}

function writeRentsNeeded(listings: Listing[], rents: Record<string, RentEntry>, cfg: Config) {
  const houses = listings
    .filter((l) => !passesSearch(l, cfg.search))
    .map((l) => ({
      key: rentKey(l),
      address: `${l.address}, ${l.city}, ${l.state} ${l.zip}`.trim(),
      street: l.address, city: l.city, state: l.state, zip: l.zip,
      propertyType: l.propertyType, beds: l.beds ?? null, baths: l.baths ?? null, sqft: l.sqft ?? null,
      listPrice: l.price,
      hasRent: !!rents[rentKey(l)],
    }));
  writeFileSync(join(ROOT, "out", "rents-needed.json"), JSON.stringify({ houses }, null, 2) + "\n");
}

function loadLastScan(): Listing[] {
  for (const p of [LAST_SCAN, SEED_SCAN]) {
    if (existsSync(join(ROOT, p))) {
      const l: Listing[] = JSON.parse(readFileSync(join(ROOT, p), "utf8"));
      console.log(`Reusing ${l.length} listings from ${p} (no RentCast calls)`);
      return l;
    }
  }
  console.log("No earlier scan saved yet; nothing to reuse");
  return [];
}

interface Config {
  maxApiCallsPerRun: number;
  maxApiCallsPerMonth: number;
  billingDay: number;
  markets: { city: string; state: string }[];
  search: { minPrice: number; maxPrice: number; propertyTypes: string[]; excludeListingTypes: string[]; skipHoa: boolean };
  buyer: BuyerAssumptions & { taxFallbackPctOfPrice: number };
  offer: OfferRules;
  flip: FlipAssumptions;
  photos: PhotoConfig;
  // "file" = rent only from rents/rents.json (your own script); "rentcast" = RentCast, with rents.json overriding it
  rentSource?: "rentcast" | "file";
}

export interface Lead extends Listing {
  deal: DealResult;
  isNew: boolean;
  dealType: "Rental" | "Flip" | null;
  flipRehab?: number;
  flipProfit?: number;
  photoFolder?: string;
  condition?: ConditionRating;
}

interface CacheEntry {
  rent?: { rent: number; low: number; high: number } | null;
  tax?: number;
  hoa?: number;
  value?: number;
  valueChecked?: boolean;
  taxChecked?: boolean;
  fetchedAt: string;
  firstSeen: string;
}

const REFRESH_DAYS = 30;

function loadEnv() {
  const p = join(ROOT, ".env");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

function arg(name: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

export function passesSearch(l: Listing, s: Config["search"]): string | null {
  if (l.price < s.minPrice || l.price > s.maxPrice) return "Outside price range";
  if (!s.propertyTypes.includes(l.propertyType)) return `Property type ${l.propertyType}`;
  if (l.listingType && s.excludeListingTypes.includes(l.listingType)) return `Listing type ${l.listingType}`;
  if (s.skipHoa && (l.monthlyHoa ?? 0) > 0) return "Has an HOA";
  return null;
}

// Would this home qualify (or nearly) if its tax bill were the fallback estimate?
function looksPromising(l: Listing, cfg: Config): boolean {
  const d = analyze(
    { listPrice: l.price, monthlyRent: l.monthlyRent!, annualTax: l.price * cfg.buyer.taxFallbackPctOfPrice, monthlyHoa: l.monthlyHoa },
    cfg.buyer,
    cfg.offer,
  );
  return d.ceilingOffer >= d.floorOffer - l.price * 0.05;
}

// A photo rating replaces the price-based rental/flip guess: rental_ready = Rental, anything else = Flip,
// and Claude's rehab estimate replaces the flat $/sqft number in the flip profit.
export function applyRating(lead: Lead, r: ConditionRating, cfg: Config) {
  lead.condition = r;
  lead.dealType = r.condition === "rental_ready" ? "Rental" : "Flip";
  if (lead.dealType === "Flip" && lead.value) {
    lead.flipRehab = Math.round(r.rehab_estimate);
    lead.flipProfit = Math.round(lead.value - lead.deal.buyerMaxPrice - r.rehab_estimate - lead.value * cfg.flip.costsPctOfArv);
  } else {
    lead.flipRehab = undefined;
    lead.flipProfit = undefined;
  }
}

async function ratePhotos(leads: Lead[], cfg: Config) {
  const ratingsPath = join(ROOT, "data", "ratings.json");
  const ratings: Record<string, ConditionRating> = existsSync(ratingsPath) ? JSON.parse(readFileSync(ratingsPath, "utf8")) : {};
  const key = process.env.ANTHROPIC_API_KEY;
  const client = key ? new Anthropic({ apiKey: key }) : null;
  let rated = 0, cached = 0, withPhotos = 0, skippedNoKey = 0, capped = 0;
  for (const lead of leads) {
    lead.photoFolder = photoFolderName(lead);
    const files = listPhotos(join(ROOT, PHOTOS_DIR, lead.photoFolder), cfg.photos.maxPhotosPerHouse);
    if (!files.length) continue;
    withPhotos++;
    const k = photoSetKey(lead.photoFolder, files);
    if (ratings[k]) { applyRating(lead, ratings[k], cfg); cached++; continue; }
    if (!client) { skippedNoKey++; continue; }
    if (rated >= cfg.photos.maxHousesPerRun) { capped++; continue; }
    try {
      const r = await rateHouse(client, lead, files, cfg.photos);
      rated++;
      if (r) { ratings[k] = r; applyRating(lead, r, cfg); }
      else console.log(`  Claude declined to rate ${lead.address}`);
    } catch (e: any) {
      console.log(`  Photo rating failed for ${lead.address}: ${e.message ?? e}`);
    }
  }
  writeFileSync(ratingsPath, JSON.stringify(ratings, null, 1));
  writeFileSync(join(ROOT, "out", "photo-folders.txt"),
    leads.map((l) => `${PHOTOS_DIR}/${l.photoFolder}/   ${l.condition ? conditionLabel(l.condition.condition) : "(no rating yet)"}`).join("\n") + "\n");
  // The to-do list for a photo downloader: every lead, where its photos go, and whether they're there yet.
  // The workflow commits this to photos/needed.json.
  const needed = leads.map((l) => ({
    address: `${l.address}, ${l.city}, ${l.state} ${l.zip}`.trim(),
    street: l.address, city: l.city, state: l.state, zip: l.zip,
    folder: `${PHOTOS_DIR}/${l.photoFolder}`,
    hasPhotos: listPhotos(join(ROOT, PHOTOS_DIR, l.photoFolder!), 1).length > 0,
    rated: !!l.condition,
    tier: l.deal.tier,
  }));
  writeFileSync(join(ROOT, "out", "needed.json"), JSON.stringify({ houses: needed }, null, 2) + "\n");
  console.log(`Photos: ${withPhotos} of ${leads.length} leads have photos; rated ${rated} new, ${cached} from cache` +
    (skippedNoKey ? `, ${skippedNoKey} waiting for ANTHROPIC_API_KEY` : "") + (capped ? `, ${capped} over the per-run cap` : ""));
}

export function evaluate(listings: Listing[], cfg: Config, today: string, firstSeen: (l: Listing) => string, showAll = false) {
  const leads: Lead[] = [];
  const rejected: { l: Listing; reason: string; deal?: DealResult }[] = [];
  for (const l of listings) {
    const skip = passesSearch(l, cfg.search);
    if (skip) { rejected.push({ l, reason: skip }); continue; }
    if (!l.monthlyRent) { rejected.push({ l, reason: "No rent estimate" }); continue; }
    if (l.annualTax == null) {
      l.annualTax = l.price * cfg.buyer.taxFallbackPctOfPrice;
      l.taxEstimated = true;
    }
    const deal = analyze(
      { listPrice: l.price, monthlyRent: l.monthlyRent, annualTax: l.annualTax, annualInsurance: l.annualInsurance, monthlyHoa: l.monthlyHoa },
      cfg.buyer,
      cfg.offer,
    );
    if (deal.qualifies || showAll) {
      const type = dealType(l.price, l.value, cfg.flip);
      const flip = type === "Flip" && l.value ? flipProfit(l.value, deal.buyerMaxPrice, l.sqft, cfg.flip) : undefined;
      leads.push({ ...l, deal, isNew: firstSeen(l) === today, dealType: type, flipRehab: flip?.rehab, flipProfit: flip?.profit });
    }
    else rejected.push({ l, reason: deal.reason, deal });
  }
  const tierRank = { A: 0, B: 1, C: 2 } as const;
  leads.sort((a, b) => (tierRank[a.deal.tier!] ?? 3) - (tierRank[b.deal.tier!] ?? 3) || b.deal.feeAtFloor - a.deal.feeAtFloor);
  return { leads, rejected };
}

export async function main() {
  loadEnv();
  const cfg: Config = JSON.parse(readFileSync(join(ROOT, "config.json"), "utf8"));
  const today = new Date().toISOString().slice(0, 10);
  const cachePath = join(ROOT, "data", "cache.json");
  mkdirSync(join(ROOT, "data"), { recursive: true });
  mkdirSync(join(ROOT, "out"), { recursive: true });
  const cache: Record<string, CacheEntry> = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, "utf8")) : {};

  const rentFile = loadRentFile();
  let listings: Listing[] = [];
  const csv = arg("csv");
  if (csv) {
    listings = loadCsv(csv);
    for (const l of listings) cache[l.id] ??= { fetchedAt: today, firstSeen: today };
    console.log(`Loaded ${listings.length} listings from ${csv}`);
  } else if (arg("limit") === "0") {
    listings = loadLastScan();
  } else {
    const key = process.env.RENTCAST_API_KEY;
    if (!key) throw new Error("Set RENTCAST_API_KEY in .env (or use --csv file.csv)");
    // --limit N: test mode. Pull only N listings, look up all of them, and show every one
    // in the spreadsheet even if it isn't a deal (about 1 + 3N calls).
    const testLimit = arg("limit") ? Number(arg("limit")) : 0;
    const only = arg("market");
    const markets = only
      ? [{ city: only.split(",")[0].trim(), state: only.split(",")[1].trim() }]
      : cfg.markets;
    // Hard cap on paid API calls per run (config.maxApiCallsPerRun). Anything not looked up
    // this run waits for the next one, longest-listed homes first.
    // Also a monthly cap, tracked in data/usage.json, so a daily schedule can't blow past the plan.
    const usagePath = join(ROOT, "data", "usage.json");
    // Count by RentCast billing period (resets on config.billingDay), not calendar month.
    const d = new Date(today + "T00:00:00Z");
    if (d.getUTCDate() < cfg.billingDay) d.setUTCMonth(d.getUTCMonth() - 1);
    const month = `${d.toISOString().slice(0, 7)}-${String(cfg.billingDay).padStart(2, "0")}`;
    const usage: Record<string, number> = existsSync(usagePath) ? JSON.parse(readFileSync(usagePath, "utf8")) : {};
    // Older runs counted by calendar month ("2026-11"); fold that into the current period.
    const old = today.slice(0, 7);
    if (usage[old] != null && !usage[month]) { usage[month] = usage[old]; delete usage[old]; }
    const leftThisMonth = cfg.maxApiCallsPerMonth - (usage[month] ?? 0);
    const budget = Math.max(0, Math.min(cfg.maxApiCallsPerRun, leftThisMonth));
    if (budget === 0) console.log(`Monthly API budget (${cfg.maxApiCallsPerMonth}) used up for ${month}; using cached data only`);
    let calls = 0;
    const canCall = () => calls < budget;
    for (const m of markets) {
      if (!canCall()) { console.log(`Call budget used up, skipping ${m.city}, ${m.state}`); continue; }
      const found = testLimit
        ? await fetchListings(m, cfg.search, key, 1, testLimit)
        : await fetchListings(m, cfg.search, key, Math.max(1, Math.min(20, budget - calls)));
      calls += Math.max(1, Math.ceil(found.length / 500));
      console.log(`${m.city}, ${m.state}: ${found.length} active listings`);
      found.sort((a, b) => (b.daysOnMarket ?? 0) - (a.daysOnMarket ?? 0));
      let waiting = 0;
      for (const l of found) {
        // Only spend API calls on listings that pass the free filters first.
        if (passesSearch(l, cfg.search)) { listings.push(l); continue; }
        const c = (cache[l.id] ??= { fetchedAt: "", firstSeen: today });
        if (rentFile[rentKey(l)]) {
          // Rent from your own script (rents/rents.json): no RentCast rent call.
        } else if (cfg.rentSource !== "file") {
          const stale = !c.fetchedAt || (Date.parse(today) - Date.parse(c.fetchedAt)) / 864e5 > REFRESH_DAYS;
          if (stale) {
            if (!canCall()) { waiting++; continue; }
            c.rent = await fetchRent(l, key);
            calls++;
            c.fetchedAt = today;
            c.tax = undefined;
            c.taxChecked = false;
          }
          if (c.rent) { l.monthlyRent = c.rent.rent; l.rentLow = c.rent.low; l.rentHigh = c.rent.high; }
        }
        applyFileRent(l, rentFile);
        const hasRent = !!l.monthlyRent;
        // Second call (county tax record) only for homes that look like they could work
        // with an estimated tax bill. Saves roughly half the calls.
        if (hasRent && !c.taxChecked && (testLimit || looksPromising(l, cfg))) {
          if (!canCall()) { waiting++; listings.push(l); continue; }
          const t = await fetchTaxAndHoa(l, key);
          calls++;
          c.tax = t.tax;
          c.hoa = t.hoa;
          c.taxChecked = true;
        }
        // Value estimate (for the rental-vs-flip label and flip profit), also only for promising homes.
        if (hasRent && c.taxChecked && !c.valueChecked && (testLimit || looksPromising(l, cfg)) && canCall()) {
          c.value = await fetchValue(l, key);
          c.valueChecked = true;
          calls++;
        }
        if (c.tax != null) l.annualTax = c.tax;
        if (c.value) l.value = c.value;
        if (c.hoa && !l.monthlyHoa) l.monthlyHoa = c.hoa;
        listings.push(l);
      }
      if (waiting) console.log(`  ${waiting} listings still need lookups; they'll be done on the next runs`);
      writeFileSync(cachePath, JSON.stringify(cache, null, 1));
    }
    usage[month] = (usage[month] ?? 0) + calls;
    writeFileSync(usagePath, JSON.stringify(usage, null, 1));
    console.log(`RentCast calls this run: ${calls} (month so far: ${usage[month]} of ${cfg.maxApiCallsPerMonth})`);
    // Budget used up before anything was pulled: fall back to the last scan instead of an empty sheet.
    if (calls === 0 && !listings.length) listings = loadLastScan();
    else {
      // A full scan replaces the saved listings; a --limit test run only adds to them.
      const prev: Listing[] = testLimit && existsSync(join(ROOT, LAST_SCAN)) ? JSON.parse(readFileSync(join(ROOT, LAST_SCAN), "utf8")) : [];
      const byId = new Map([...prev, ...listings].map((l) => [l.id, l]));
      writeFileSync(join(ROOT, LAST_SCAN), JSON.stringify([...byId.values()]));
    }
  }

  for (const l of listings) applyFileRent(l, rentFile);
  writeRentsNeeded(listings, rentFile, cfg);

  const { leads, rejected } = evaluate(listings, cfg, today, (l) => cache[l.id]?.firstSeen ?? today, Number(arg("limit") ?? 0) > 0);
  writeFileSync(cachePath, JSON.stringify(cache, null, 1));

  await ratePhotos(leads, cfg);

  const xlsx = join(ROOT, "out", `leads-${today}.xlsx`);
  const html = join(ROOT, "out", `cards-${today}.html`);
  await writeSpreadsheet(xlsx, leads, rejected, cfg);
  writeCards(html, leads, today, cfg);
  writeCards(join(ROOT, "out", "latest.html"), leads, today, cfg);

  const t = (x: string) => leads.filter((l) => l.deal.tier === x).length;
  console.log(`\n${leads.length} leads qualify (A: ${t("A")}, B: ${t("B")}, C: ${t("C")}), ${rejected.length} skipped`);
  console.log(`Spreadsheet: ${xlsx}\nCards:       ${html}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
}
