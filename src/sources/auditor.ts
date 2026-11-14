// Actual property tax from the Hamilton County (OH) Auditor's public property search
// (https://wedge1.hcauditor.org). One search per house; an exact house number + street
// name lands straight on the parcel's summary page, which shows "Total Tax" for the year.
import type { Listing } from "./types.ts";

const BASE = "https://wedge1.hcauditor.org";
const UA = "Mozilla/5.0 (deal-finder; daily property tax lookup)";

export type CountyTax = {
  tax?: number; // yearly tax a buyer would pay: assessed value x effective rate (no owner credits, no back taxes)
  billed?: number; // "Total Tax" on the county page (can include back taxes and the owner's credits)
  rate?: number; // effective tax rate, mills
  foreclosure?: boolean;
  delinquent?: boolean; // billed is well above one year's tax
  taxYear?: string; // e.g. "2025 Payable 2026"
  parcel?: string;
  assessed?: number;
  marketValue?: number;
  checked: string; // YYYY-MM-DD
  found: boolean;
};

let cookie = "";

async function startSession() {
  const r = await fetch(BASE + "/", { headers: { "User-Agent": UA } });
  keepCookies(r);
  await r.text();
}

const SUFFIX = /\s+(ave|avenue|st|street|rd|road|dr|drive|ct|court|ln|lane|pl|place|blvd|ter|terrace|way|pike|cir|circle|pkwy|hwy|aly|alley|row|trl|sq)\.?$/i;
const DIRECTION = /^(n|s|e|w|north|south|east|west)\s+/i;
const TENS = ["twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

// "127 W Sixty Fourth St" -> number "127", names to try ["Sixty Fourth", "Sixty-Fourth", "Sixty"]
export function searchTerms(street: string): { number: string; names: string[] } | null {
  const m = street.trim().match(/^(\d+)[a-z]?\s+(.+)$/i);
  if (!m) return null;
  let name = m[2].replace(/\s+(apt|unit|#).*$/i, "").replace(SUFFIX, "").trim();
  const noDir = name.replace(DIRECTION, "").trim();
  const names = [noDir];
  const hy = noDir.replace(new RegExp(`\\b(${TENS.join("|")})\\s+`, "i"), "$1-");
  if (hy !== noDir) names.push(hy);
  if (noDir !== name) names.push(name);
  const first = noDir.split(/\s+/)[0];
  if (first !== noDir && first.length > 3) names.push(first);
  return { number: m[1], names: [...new Set(names)] };
}

function text(html: string) {
  return html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");
}

const num = (s?: string) => (s ? Number(s.replace(/[$,]/g, "")) : undefined);

export function parseSummary(html: string): Omit<CountyTax, "checked" | "found"> | null {
  const t = text(html);
  const billed = num(t.match(/Total Tax \$?([\d,]+\.?\d*)/i)?.[1]);
  const assessed = num(t.match(/Assessed Value ([\d,]+)/i)?.[1]);
  const rate = num(t.match(/Effective Tax Rate ([\d.]+)/i)?.[1]);
  if (billed == null && !(assessed && rate)) return null;
  const yearly = assessed && rate ? Math.round((assessed * rate) / 1000) : Math.round(billed!);
  return {
    tax: yearly,
    billed: billed != null ? Math.round(billed) : undefined,
    rate,
    foreclosure: /Foreclosure Yes/i.test(t),
    delinquent: billed != null && billed > yearly * 1.5,
    taxYear: t.match(/Tax Year (\d{4} Payable \d{4})/i)?.[1],
    parcel: t.match(/Parcel ID ([\d-]+)/i)?.[1],
    assessed,
    marketValue: num(t.match(/Market Total Value ([\d,]+)/i)?.[1]),
  };
}

function keepCookies(r: Response) {
  const jar = new Map(cookie.split("; ").filter(Boolean).map((c) => [c.split("=")[0], c] as [string, string]));
  for (const c of r.headers.getSetCookie?.() ?? []) { const kv = c.split(";")[0]; jar.set(kv.split("=")[0], kv); }
  cookie = [...jar.values()].join("; ");
}

// POST the search, then follow the redirects by hand (the site keeps the results in a session cookie):
// /execute -> /results -> /view/re/<parcel>/<year>/summary when there's exactly one match.
async function searchOnce(number: string, name: string): Promise<string | null> {
  const body = new URLSearchParams({
    search_type: "Address", sort_column: "Address",
    site_house_number_low: number, site_house_number_high: "", site_street_name: name,
  });
  let r = await fetch(BASE + "/execute", {
    method: "POST", body, redirect: "manual",
    headers: { "User-Agent": UA, Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
  });
  for (let hops = 0; hops < 5; hops++) {
    keepCookies(r);
    const loc = r.headers.get("location");
    if (!loc || r.status < 300 || r.status >= 400) break;
    await r.text();
    r = await fetch(new URL(loc, BASE), { redirect: "manual", headers: { "User-Agent": UA, Cookie: cookie } });
  }
  const html = await r.text();
  if (/Total Tax/i.test(html)) return html;
  // Several matches: pick the row whose address is this house number on this street (with the right suffix).
  const parcel = pickFromResults(html, number, name, suffixWanted);
  if (!parcel) return null;
  // Fresh request without the session cookie (with it, the site answers 500 here).
  const page = await fetch(`${BASE}/view/re/${parcel.replace(/-/g, "")}`, { headers: { "User-Agent": UA } });
  return page.ok ? page.text() : null;
}

let suffixWanted = "";

function pickFromResults(html: string, number: string, name: string, suffix: string): string | null {
  const rows = [...html.matchAll(/<tr[\s\S]*?<\/tr>/gi)].map((m) =>
    [...m[0].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => c[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim()),
  ).filter((c) => /^\d{3}-[\dA-Z]{4}-\d{4}-\d{2}$/.test(c[0] ?? ""));
  const words = name.toUpperCase().replace(/-/g, " ").split(/\s+/);
  const hits = rows.filter(([, , addr = ""]) => {
    const a = addr.toUpperCase().replace(/-/g, " ").split(/\s+/);
    if (a[0] !== number) return false;
    if (!words.every((w) => a.includes(w))) return false;
    return !suffix || a[a.length - 1] === suffix || !SUFFIX.test(" " + a[a.length - 1]);
  });
  return hits.length === 1 ? hits[0][0] : null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function fetchCountyTax(l: Listing): Promise<CountyTax> {
  const checked = new Date().toISOString().slice(0, 10);
  const terms = searchTerms(l.address);
  if (!terms) return { checked, found: false };
  const sfx = (l.address.trim().match(SUFFIX)?.[1] ?? "").toUpperCase();
  const LONG: Record<string, string> = { AVENUE: "AVE", STREET: "ST", ROAD: "RD", DRIVE: "DR", COURT: "CT", LANE: "LN", PLACE: "PL", TERRACE: "TER", CIRCLE: "CIR", ALLEY: "ALY" };
  suffixWanted = LONG[sfx] ?? sfx;
  // Fresh session for every house: the site's session goes stale after a few dozen searches
  // and then answers every search with an empty result list.
  cookie = "";
  await startSession();
  for (const name of terms.names) {
    const html = await searchOnce(terms.number, name);
    await sleep(400); // be polite to the county's site
    const got = html && parseSummary(html);
    if (got) return { ...got, checked, found: true };
  }
  return { checked, found: false };
}

// Only Hamilton County is supported for now: Cincinnati's 452xx ZIPs plus the county's other ZIPs.
const HAMILTON_OTHER = new Set(["45001", "45002", "45030", "45033", "45041", "45051", "45052", "45111", "45174"]);
export const inHamiltonCounty = (l: Listing) => {
  const z = String(l.zip ?? "").slice(0, 5);
  return l.state === "OH" && (z.startsWith("452") || HAMILTON_OTHER.has(z));
};
