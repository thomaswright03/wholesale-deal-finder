// Daily run: pull listings for each market, get rent + taxes, run the deal math,
// write a spreadsheet and a card page of the leads that work.
//
//   node src/run.ts                      all markets in config.json (needs RENTCAST_API_KEY)
//   node src/run.ts --market "Dayton, OH"  one market
//   node src/run.ts --csv listings.csv     use a CSV instead of RentCast
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { analyze, type BuyerAssumptions, type DealResult, type OfferRules } from "./deal.ts";
import { loadCsv } from "./sources/csv.ts";
import { fetchListings, fetchRent, fetchTaxAndHoa } from "./sources/rentcast.ts";
import type { Listing } from "./sources/types.ts";
import { writeCards, writeSpreadsheet } from "./output.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

interface Config {
  maxApiCallsPerRun: number;
  maxApiCallsPerMonth: number;
  markets: { city: string; state: string }[];
  search: { minPrice: number; maxPrice: number; propertyTypes: string[]; excludeListingTypes: string[]; skipHoa: boolean };
  buyer: BuyerAssumptions & { taxFallbackPctOfPrice: number };
  offer: OfferRules;
}

export interface Lead extends Listing {
  deal: DealResult;
  isNew: boolean;
}

interface CacheEntry {
  rent?: { rent: number; low: number; high: number } | null;
  tax?: number;
  hoa?: number;
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

export function evaluate(listings: Listing[], cfg: Config, today: string, firstSeen: (l: Listing) => string) {
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
    if (deal.qualifies) leads.push({ ...l, deal, isNew: firstSeen(l) === today });
    else rejected.push({ l, reason: deal.reason, deal });
  }
  const tierRank = { A: 0, B: 1, C: 2 } as const;
  leads.sort((a, b) => tierRank[a.deal.tier!] - tierRank[b.deal.tier!] || b.deal.feeAtFloor - a.deal.feeAtFloor);
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

  let listings: Listing[] = [];
  const csv = arg("csv");
  if (csv) {
    listings = loadCsv(csv);
    for (const l of listings) cache[l.id] ??= { fetchedAt: today, firstSeen: today };
    console.log(`Loaded ${listings.length} listings from ${csv}`);
  } else {
    const key = process.env.RENTCAST_API_KEY;
    if (!key) throw new Error("Set RENTCAST_API_KEY in .env (or use --csv file.csv)");
    const only = arg("market");
    const markets = only
      ? [{ city: only.split(",")[0].trim(), state: only.split(",")[1].trim() }]
      : cfg.markets;
    // Hard cap on paid API calls per run (config.maxApiCallsPerRun). Anything not looked up
    // this run waits for the next one, longest-listed homes first.
    // Also a monthly cap, tracked in data/usage.json, so a daily schedule can't blow past the plan.
    const usagePath = join(ROOT, "data", "usage.json");
    const month = today.slice(0, 7);
    const usage: Record<string, number> = existsSync(usagePath) ? JSON.parse(readFileSync(usagePath, "utf8")) : {};
    const leftThisMonth = cfg.maxApiCallsPerMonth - (usage[month] ?? 0);
    const budget = Math.max(0, Math.min(cfg.maxApiCallsPerRun, leftThisMonth));
    if (budget === 0) console.log(`Monthly API budget (${cfg.maxApiCallsPerMonth}) used up for ${month}; using cached data only`);
    let calls = 0;
    const canCall = () => calls < budget;
    for (const m of markets) {
      if (!canCall()) { console.log(`Call budget used up, skipping ${m.city}, ${m.state}`); continue; }
      const found = await fetchListings(m, cfg.search, key, Math.max(1, Math.min(20, budget - calls)));
      calls += Math.max(1, Math.ceil(found.length / 500));
      console.log(`${m.city}, ${m.state}: ${found.length} active listings`);
      found.sort((a, b) => (b.daysOnMarket ?? 0) - (a.daysOnMarket ?? 0));
      let waiting = 0;
      for (const l of found) {
        // Only spend API calls on listings that pass the free filters first.
        if (passesSearch(l, cfg.search)) { listings.push(l); continue; }
        const c = (cache[l.id] ??= { fetchedAt: "", firstSeen: today });
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
        // Second call (county tax record) only for homes that look like they could work
        // with an estimated tax bill. Saves roughly half the calls.
        if (c.rent && !c.taxChecked && looksPromising(l, cfg)) {
          if (!canCall()) { waiting++; listings.push(l); continue; }
          const t = await fetchTaxAndHoa(l, key);
          calls++;
          c.tax = t.tax;
          c.hoa = t.hoa;
          c.taxChecked = true;
        }
        if (c.tax != null) l.annualTax = c.tax;
        if (c.hoa && !l.monthlyHoa) l.monthlyHoa = c.hoa;
        listings.push(l);
      }
      if (waiting) console.log(`  ${waiting} listings still need lookups; they'll be done on the next runs`);
      writeFileSync(cachePath, JSON.stringify(cache, null, 1));
    }
    usage[month] = (usage[month] ?? 0) + calls;
    writeFileSync(usagePath, JSON.stringify(usage, null, 1));
    console.log(`RentCast calls this run: ${calls} (month so far: ${usage[month]} of ${cfg.maxApiCallsPerMonth})`);
  }

  const { leads, rejected } = evaluate(listings, cfg, today, (l) => cache[l.id]?.firstSeen ?? today);
  writeFileSync(cachePath, JSON.stringify(cache, null, 1));

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
