// Daily run: pull listings for each market, get rent + taxes, run the deal math,
// write a spreadsheet and a card page of the leads that work.
//
//   node src/run.ts                      all markets in config.json (needs RENTCAST_API_KEY)
//   node src/run.ts --market "Dayton, OH"  one market
//   node src/run.ts --csv listings.csv     use a CSV instead of RentCast
//   node src/run.ts --limit 0              no RentCast calls: reuse the last scan's listings
//                                          (e.g. to rate newly added photos)
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { analyze, dealType, flipDeal, flipProfit, type BuyerAssumptions, type DealResult, type FlipAssumptions, type OfferRules } from "./deal.ts";
import { loadCsv } from "./sources/csv.ts";
import { fetchMortgageRate } from "./sources/rate.ts";
import { fetchCountyTax, inHamiltonCounty, type CountyTax } from "./sources/auditor.ts";
import { fetchCountyArv, type CountyArv } from "./sources/comps.ts";
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
type RentEntry = { rent: number; low?: number; high?: number; value?: number; tax?: number; propertyTax?: number; source?: string; date?: string };
const rentKey = (l: Listing) => photoFolderName(l);

function loadRentFile(): Record<string, RentEntry> {
  const p = join(ROOT, RENTS_DIR, "rents.json");
  if (!existsSync(p)) return {};
  const raw = JSON.parse(readFileSync(p, "utf8"));
  const out: Record<string, RentEntry> = {};
  for (const [k, v] of Object.entries<any>(raw)) {
    const rent = Number(typeof v === "number" ? v : v?.rent);
    // Keep tax / value even when the script found no rent (HUD fills the rent).
    if (rent > 0) out[k] = typeof v === "number" ? { rent } : { ...v, rent };
    else if (v && typeof v === "object" && (Number(v.tax ?? v.propertyTax) > 0 || Number(v.value) > 0)) out[k] = { ...v, rent: 0 };
  }
  console.log(`Rents from your script (rents/rents.json): ${Object.values(out).filter((r) => r.rent > 0).length} rents, ${Object.keys(out).length} houses`);
  return out;
}

// Backup rent: HUD Small Area Fair Market Rents by ZIP and bedrooms (reference/hud-safmr-*.json).
// 40th percentile gross rent, so it runs conservative. Used only when your script has no rent.
type Hud = { year: number; zips: Record<string, number[]> };
let hudCache: Hud | null | undefined;
function loadHud(): Hud | null {
  if (hudCache !== undefined) return hudCache;
  const dir = join(ROOT, "reference");
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => /^hud-safmr-\d{4}\.json$/.test(f)).sort() : [];
  hudCache = files.length ? JSON.parse(readFileSync(join(dir, files[files.length - 1]), "utf8")) : null;
  if (hudCache) console.log(`HUD backup rents: FY${hudCache.year}, ${Object.keys(hudCache.zips).length} ZIP codes`);
  return hudCache;
}

function hudRent(l: Listing): number | undefined {
  const row = loadHud()?.zips[String(l.zip ?? "").slice(0, 5)];
  if (!row) return undefined;
  // HUD rents are per unit and listings don't give a unit count, so a multi-family
  // is assumed to be a duplex of two 2-bedroom units (capped at tier B; see findLeads).
  if (isMulti(l)) return 2 * row[2];
  const beds = Math.max(0, Math.min(4, Math.round(l.beds ?? 3)));
  return row[beds];
}

const isMulti = (l: Listing) => /multi/i.test(l.propertyType ?? "");
const DUPLEX_GUESS = (l: Listing) => isMulti(l) && !!l.rentSource?.startsWith("HUD");

function applyFileRent(l: Listing, rents: Record<string, RentEntry>) {
  const r = rents[rentKey(l)];
  if (r && r.rent > 0) {
    l.monthlyRent = r.rent;
    l.rentLow = r.low ?? r.rent;
    l.rentHigh = r.high ?? r.rent;
    l.rentSource = r.source ?? "Property Genie";
  } else if (!l.monthlyRent) {
    const hud = hudRent(l);
    if (hud) {
      l.monthlyRent = hud; l.rentLow = hud; l.rentHigh = hud;
      l.rentSource = `HUD FMR ${loadHud()!.year}` + (isMulti(l) ? " (duplex guess)" : "");
    }
  }
  if (!r) return;
  // Optional as-is value / ARV from your script; used for flip profit (skips the RentCast value call).
  if (Number(r.value) > 0) l.value = Number(r.value);
  // Optional actual annual property tax (e.g. from the county auditor's bill) beats any estimate.
  const tax = Number(r.tax ?? r.propertyTax);
  if (tax > 0) { l.annualTax = tax; l.taxEstimated = false; }
}

// Actual tax bills from the county auditor, saved in taxes/county.json (committed by the daily run)
// so each house is looked up once. Houses not found are retried after 30 days.
const COUNTY_FILE = join("taxes", "county.json");
async function applyCountyTaxes(listings: Listing[], cfg: Config) {
  const p = join(ROOT, COUNTY_FILE);
  const saved: Record<string, CountyTax> = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
  const retryBefore = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const max = cfg.maxCountyLookupsPerRun ?? 600;
  let looked = 0, found = 0, failed = 0;
  for (const l of listings) {
    if (passesSearch(l, cfg.search) || !inHamiltonCounty(l)) continue;
    const key = rentKey(l);
    let t = saved[key];
    if ((!t || (!t.found && t.checked < retryBefore)) && looked < max && failed < 5) {
      try {
        t = await fetchCountyTax(l);
        saved[key] = t; looked++; failed = 0;
        if (t.found) found++;
      } catch (e) {
        failed++;
        console.log(`County tax lookup failed for ${l.address}: ${(e as Error).message}`);
      }
    }
    if (t?.found && t.tax) {
      l.annualTax = t.tax;
      l.taxEstimated = false;
      l.taxSource = `Hamilton County Auditor${t.taxYear ? `, ${t.taxYear}` : ""}`
        + (t.foreclosure ? "; county shows FORECLOSURE" : "")
        + (t.delinquent && t.billed ? `; owner owes back taxes (bill $${t.billed.toLocaleString("en-US")})` : "");
    }
  }
  mkdirSync(join(ROOT, "taxes"), { recursive: true });
  writeFileSync(p, JSON.stringify(saved, null, 1) + "\n");
  const have = Object.values(saved).filter((t) => t.found).length;
  console.log(`County taxes: looked up ${looked} (${found} found), ${have} saved in ${COUNTY_FILE}${failed >= 5 ? " (stopped: site not answering)" : ""}`);
}

// ARV (column "Value / ARV") from recent county sales near each house. Needs the parcel from the
// county tax lookup. Saved to taxes/arv.json and refreshed every 30 days.
const ARV_FILE = join("taxes", "arv.json");
async function applyCountyArv(listings: Listing[], cfg: Config) {
  const p = join(ROOT, ARV_FILE);
  const taxes: Record<string, CountyTax> = existsSync(join(ROOT, COUNTY_FILE)) ? JSON.parse(readFileSync(join(ROOT, COUNTY_FILE), "utf8")) : {};
  const saved: Record<string, CountyArv> = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
  const refreshBefore = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const max = cfg.maxCountyLookupsPerRun ?? 600;
  let looked = 0, found = 0, failed = 0, refused = 0, refusedRow = 0;
  for (const l of listings) {
    if (passesSearch(l, cfg.search) || !inHamiltonCounty(l)) continue;
    const key = rentKey(l);
    const parcel = taxes[key]?.parcel;
    if (!parcel || !l.sqft) continue;
    let a = saved[key];
    if ((!a || a.checked < refreshBefore) && looked < max && failed < 5) {
      try {
        const got = await fetchCountyArv(l, parcel, isMulti(l));
        looked++; failed = 0;
        if (got.error) {
          // County refused the search for this parcel; try again next run. Many in a row = site trouble.
          refused++;
          if (refused === 1 || refused % 25 === 0) console.log(`County sales search refused ${l.address} (${got.error}); ${refused} so far`);
        } else {
          saved[key] = a = got; refusedRow = 0;
          if (got.found) found++;
        }
        if (got.error && ++refusedRow >= 15) { console.log("County sales search refused 15 in a row; stopping for this run"); failed = 5; }
      } catch (e) {
        failed++;
        console.log(`County sales lookup failed for ${l.address}: ${(e as Error).message}`);
      }
    }
    if (a?.found && a.arv) {
      l.value = a.arv;
      l.arvSource = `ARV from ${a.comps} county sales within ${a.radiusFt === 2640 ? "1/2 mile" : "1 mile"} in the last year (top quarter $${a.ppsf}/sqft; sales $${a.low!.toLocaleString("en-US")}-$${a.high!.toLocaleString("en-US")})`;
    }
  }
  writeFileSync(p, JSON.stringify(saved, null, 1) + "\n");
  const have = Object.values(saved).filter((a) => a.found).length;
  console.log(`County ARV: looked up ${looked} (${found} found, ${refused} refused by the county), ${have} saved in ${ARV_FILE}${failed >= 5 ? " (stopped: site not answering)" : ""}`);
}

function writeRentsNeeded(listings: Listing[], rents: Record<string, RentEntry>, cfg: Config) {
  const houses = listings
    .filter((l) => !passesSearch(l, cfg.search))
    .map((l) => ({
      key: rentKey(l),
      address: `${l.address}, ${l.city}, ${l.state} ${l.zip}`.trim(),
      street: l.address, city: l.city, state: l.state, zip: l.zip,
      propertyType: l.propertyType, beds: l.beds ?? null, baths: l.baths ?? null, sqft: l.sqft ?? null,
      listPrice: l.price, daysOnMarket: l.daysOnMarket ?? null,
      hasRent: (rents[rentKey(l)]?.rent ?? 0) > 0,
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
  liveMortgageRate?: boolean;
  // true = RentCast is used only for the listing search: 1 call (up to 500 listings) per market per run,
  // no tax / value lookups (your scripts supply rent and tax).
  rentcastListingsOnly?: boolean;
  // Max new county auditor tax lookups per run (default 600).
  maxCountyLookupsPerRun?: number;
  // Known RentCast usage per billing period ("YYYY-MM-DD" start), from the RentCast dashboard.
  rentcastCallsUsed?: Record<string, number>;
  rateSource?: string;
}

export interface Lead extends Listing {
  deal: DealResult;
  isNew: boolean;
  dealType: "Rental" | "Flip" | null;
  flipRehab?: number;
  flipProfit?: number;
  flipBuyer?: boolean; // qualifies only for a fix-and-flip buyer (70% of ARV minus repairs)
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
  if (lead.flipBuyer && lead.value) {
    // Price for a flip buyer depends on repairs: redo it with the photo estimate.
    lead.dealType = "Flip";
    const f = flipDeal(lead.deal, lead.value, r.rehab_estimate, cfg.flip, cfg.offer);
    if (f) lead.deal = f;
    else {
      const cut = Math.round((lead.value * (cfg.flip.maxPctOfArv ?? 0.7) - r.rehab_estimate) / 100) * 100;
      lead.deal = { ...lead.deal, buyerMaxPrice: Math.max(0, cut), ceilingOffer: Math.max(0, cut - cfg.offer.minAssignmentFee), feeAtFloor: cut - lead.deal.floorOffer, tier: "C",
        reason: `Photos show more work ($${Math.round(r.rehab_estimate).toLocaleString("en-US")}); a flip buyer would pay about $${Math.max(0, cut).toLocaleString("en-US")}, below our floor. Weak lead` };
    }
  }
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
  let rated = 0, cached = 0, withPhotos = 0, skippedNoKey = 0, capped = 0, failedRatings = 0;
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
      failedRatings++;
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
    (skippedNoKey ? `, ${skippedNoKey} waiting for ANTHROPIC_API_KEY` : "") + (capped ? `, ${capped} over the per-run cap` : "") + (failedRatings ? `, ${failedRatings} failed` : ""));
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
    let deal = analyze(
      { listPrice: l.price, monthlyRent: l.monthlyRent, annualTax: l.annualTax, annualInsurance: l.annualInsurance, monthlyHoa: l.monthlyHoa },
      cfg.buyer,
      cfg.offer,
    );
    // Rental math fails: try a fix-and-flip buyer (needs an ARV).
    let flipBuyer = false;
    if (!deal.qualifies && l.value && l.sqft) {
      const f = flipDeal(deal, l.value, l.sqft * cfg.flip.rehabPerSqft, cfg.flip, cfg.offer);
      if (f) { deal = f; flipBuyer = true; }
    }
    // Multi-family rent is a duplex guess until someone confirms the units: never tier A.
    if (DUPLEX_GUESS(l) && deal.tier === "A") deal.tier = "B";
    if (deal.qualifies || showAll) {
      const type = flipBuyer ? "Flip" : dealType(l.price, l.value, cfg.flip);
      const flip = type === "Flip" && l.value ? flipProfit(l.value, deal.buyerMaxPrice, l.sqft, cfg.flip) : undefined;
      leads.push({ ...l, deal, isNew: firstSeen(l) === today, dealType: type, flipBuyer, flipRehab: flip?.rehab, flipProfit: flip?.profit });
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

  // Live mortgage rate (config.json's interestRate is only the fallback).
  const live = cfg.liveMortgageRate === false ? null : await fetchMortgageRate();
  if (live) {
    cfg.buyer.interestRate = live.rate;
    cfg.rateSource = `${live.source}, ${live.date}`;
    console.log(`Mortgage rate: ${(live.rate * 100).toFixed(2)}% (${cfg.rateSource})`);
  } else {
    cfg.rateSource = "config.json (live rate unavailable)";
    console.log(`Mortgage rate: ${(cfg.buyer.interestRate * 100).toFixed(2)}% from config.json (live rate unavailable)`);
  }

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
    // Calls RentCast counted that this bot's counter missed (e.g. a lost cache). Never count lower than that.
    const floor = cfg.rentcastCallsUsed?.[month] ?? 0;
    if ((usage[month] ?? 0) < floor) usage[month] = floor;
    const leftThisMonth = cfg.maxApiCallsPerMonth - (usage[month] ?? 0);
    // Listings-only: one call per market per run.
    const perRun = cfg.rentcastListingsOnly ? markets.length : cfg.maxApiCallsPerRun;
    const budget = Math.max(0, Math.min(perRun, leftThisMonth));
    if (budget === 0) console.log(`Monthly API budget (${cfg.maxApiCallsPerMonth}) used up for ${month}; using cached data only`);
    let calls = 0;
    const canCall = () => calls < budget;
    for (const m of markets) {
      if (!canCall()) { console.log(`Call budget used up, skipping ${m.city}, ${m.state}`); continue; }
      const found = testLimit
        ? await fetchListings(m, cfg.search, key, 1, testLimit)
        : await fetchListings(m, cfg.search, key, cfg.rentcastListingsOnly ? 1 : Math.max(1, Math.min(20, budget - calls)));
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
        if (hasRent && !cfg.rentcastListingsOnly && !c.taxChecked && (testLimit || looksPromising(l, cfg))) {
          if (!canCall()) { waiting++; listings.push(l); continue; }
          const t = await fetchTaxAndHoa(l, key);
          calls++;
          c.tax = t.tax;
          c.hoa = t.hoa;
          c.taxChecked = true;
        }
        // Value estimate (for the rental-vs-flip label and flip profit), also only for promising homes.
        if (hasRent && !cfg.rentcastListingsOnly && c.taxChecked && !c.valueChecked && !rentFile[rentKey(l)]?.value && (testLimit || looksPromising(l, cfg)) && canCall()) {
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
  await applyCountyTaxes(listings, cfg);
  await applyCountyArv(listings, cfg);
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
