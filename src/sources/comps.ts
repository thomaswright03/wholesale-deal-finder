// After-repair value (ARV) from recent sales near the house, using the Hamilton County (OH)
// Auditor's public sales search (https://wedge1.hcauditor.org). Free, no key.
//
// Method: houses of the same use (single family or two-family) that sold in the last 12 months
// within half a mile (a mile if there aren't enough), with finished square feet within 30% of
// this house. Sales under $30k (family transfers, shells) are dropped. ARV = the 75th percentile
// price per square foot of those sales x this house's square feet. Fixed-up houses sell at the top
// of their neighborhood, so the upper quarter is a fair "after repair" number; the median would be
// closer to as-is value.
import type { Listing } from "./types.ts";

const BASE = "https://wedge1.hcauditor.org";
const UA = "Mozilla/5.0 (deal-finder; daily sales comps lookup)";
const MIN_PRICE = 30000;
const MIN_COMPS = 3;

export type Comp = { parcel: string; address: string; sqft: number; built?: number; date: string; price: number };
export type CountyArv = {
  arv?: number;
  comps?: number; // how many sales the ARV is based on
  radiusFt?: number;
  ppsf?: number; // price per sq ft used
  low?: number; // lowest and highest sale price among the comps
  high?: number;
  top?: Comp[]; // the three best sales, for checking by hand
  checked: string;
  found: boolean;
  error?: string; // why the county search gave nothing for this house
};

let cookie = "";
function keepCookies(r: Response) {
  const jar = new Map(cookie.split("; ").filter(Boolean).map((c) => [c.split("=")[0], c] as [string, string]));
  for (const c of r.headers.getSetCookie?.() ?? []) { const kv = c.split(";")[0]; jar.set(kv.split("=")[0], kv); }
  cookie = [...jar.values()].join("; ");
}
async function get(path: string) {
  const r = await fetch(new URL(path, BASE), { redirect: "manual", headers: { "User-Agent": UA, Cookie: cookie } });
  keepCookies(r);
  return r;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mdy = (d: Date) => `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;

export function parseSales(html: string): Comp[] {
  const rows = [...html.matchAll(/<tr[\s\S]*?<\/tr>/gi)].map((m) =>
    [...m[0].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => c[1].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim()),
  );
  const out: Comp[] = [];
  for (const [parcel, address, , sqft, , built, date, amount] of rows) {
    if (!/^\d{3}-[\dA-Z]{4}-\d{4}-\d{2}$/.test(parcel ?? "")) continue;
    const n = (s?: string) => Number((s ?? "").replace(/[$,]/g, ""));
    out.push({ parcel, address, sqft: n(sqft), built: n(built) || undefined, date, price: n(amount) });
  }
  return out;
}

// The county site runs on Cincinnati time; a "today" in UTC can be tomorrow there.
const easternNow = () => new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));

// Thrown when the county search refuses this one parcel (some parcels have no map location,
// so the radius search errors). Not a sign the site is down.
export class NoRadiusSearch extends Error {}

// One sales search around a parcel; returns every sale (all result pages). Tries twice.
export async function salesNear(parcel: string, feet: number, use: string): Promise<Comp[]> {
  try {
    return await salesNearOnce(parcel, feet, use);
  } catch (e) {
    if (!(e instanceof NoRadiusSearch)) throw e;
    await sleep(1500);
    return salesNearOnce(parcel, feet, use);
  }
}

async function salesNearOnce(parcel: string, feet: number, use: string): Promise<Comp[]> {
  cookie = "";
  const home = await fetch(BASE + "/", { headers: { "User-Agent": UA } });
  keepCookies(home);
  await home.text();
  const now = easternNow();
  const yearAgo = new Date(now.getTime() - 365 * 86400000);
  const body = new URLSearchParams({
    search_type: "Sales",
    sale_date_low: mdy(yearAgo), sale_date_high: mdy(now),
    sale_price_low: String(MIN_PRICE),
    origin_property_key: parcel.replace(/-/g, ""), feet_from_origin: String(feet),
    propuse: use,
  });
  let r = await fetch(BASE + "/execute", {
    method: "POST", body, redirect: "manual",
    headers: { "User-Agent": UA, Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
  });
  keepCookies(r);
  await r.text();
  if (r.status !== 302) throw new NoRadiusSearch(`sales search HTTP ${r.status}`);
  const all: Comp[] = [];
  for (let page = 1; page <= 5; page++) {
    await sleep(300);
    r = await get(`/results?page=${page}&perPage=100&sortCol=Parcel%20Number&sortDir=ascending`);
    if (r.status === 302) throw new NoRadiusSearch(`sales results sent back to ${r.headers.get("location")}`);
    if (!r.ok) throw new Error(`sales results HTTP ${r.status}`);
    const html = await r.text();
    const got = parseSales(html);
    all.push(...got);
    const total = Number(html.match(/of\s+([\d,]+)/)?.[1]?.replace(/,/g, "") ?? 0);
    if (got.length < 100 || all.length >= total) break;
  }
  return all;
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * p;
  return s[Math.floor(i)] + (s[Math.ceil(i)] - s[Math.floor(i)]) * (i - Math.floor(i));
};

export function arvFromComps(sales: Comp[], subjectParcel: string, sqft: number) {
  const comps = sales.filter((c) => c.parcel !== subjectParcel && c.sqft > 0 && c.price >= MIN_PRICE && Math.abs(c.sqft - sqft) / sqft <= 0.3);
  // Same house sold twice in the year (often a flip): keep the later, higher sale only.
  const byParcel = new Map<string, Comp>();
  for (const c of comps) { const o = byParcel.get(c.parcel); if (!o || c.price > o.price) byParcel.set(c.parcel, c); }
  const list = [...byParcel.values()];
  if (list.length < MIN_COMPS) return null;
  const ppsf = pct(list.map((c) => c.price / c.sqft), 0.75);
  const prices = list.map((c) => c.price);
  const top = [...list].sort((a, b) => b.price / b.sqft - a.price / a.sqft).slice(0, 3);
  return { arv: Math.round((ppsf * sqft) / 1000) * 1000, comps: list.length, ppsf: Math.round(ppsf), low: Math.min(...prices), high: Math.max(...prices), top };
}

export async function fetchCountyArv(l: Listing, parcel: string, multi: boolean): Promise<CountyArv> {
  const checked = new Date().toISOString().slice(0, 10);
  if (!l.sqft) return { checked, found: false };
  const use = multi ? "520" : "510"; // 510 = single family, 520 = two-family
  for (const feet of [2640, 5280]) {
    let sales: Comp[];
    try {
      sales = await salesNear(parcel, feet, use);
    } catch (e) {
      if (e instanceof NoRadiusSearch) return { checked, found: false, error: e.message };
      throw e;
    }
    const got = arvFromComps(sales, parcel, l.sqft);
    if (got) return { ...got, radiusFt: feet, checked, found: true };
  }
  return { checked, found: false };
}
