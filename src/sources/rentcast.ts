// RentCast API (https://developers.rentcast.io). One API key gives us:
//   - active for-sale listings by city with price/type filters, incl. listing agent name + phone
//   - long-term rent estimate (median rent with low/high range) per address
//   - county property record with the annual property tax bill
// Auth: header X-Api-Key, key read from RENTCAST_API_KEY in .env.
import type { Listing } from "./types.ts";

const BASE = "https://api.rentcast.io/v1";

async function get(path: string, params: Record<string, string | number>, key: string): Promise<any> {
  const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
  const url = `${BASE}${path}?${qs}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, { headers: { "X-Api-Key": key, Accept: "application/json" } });
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      continue;
    }
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`RentCast ${path} ${res.status}: ${await res.text()}`);
    return res.json();
  }
  throw new Error(`RentCast ${path}: gave up after retries`);
}

export async function fetchListings(
  market: { city: string; state: string },
  search: { minPrice: number; maxPrice: number; propertyTypes: string[] },
  key: string,
  maxPages = 20,
  pageSize = 500,
): Promise<Listing[]> {
  const out: Listing[] = [];
  const limit = pageSize;
  for (let offset = 0; offset < limit * maxPages; offset += limit) {
    const page: any[] = await get(
      "/listings/sale",
      {
        city: market.city,
        state: market.state,
        status: "Active",
        propertyType: search.propertyTypes.join("|"),
        price: `${search.minPrice}:${search.maxPrice}`,
        limit,
        offset,
      },
      key,
    );
    if (!page?.length) break;
    for (const r of page) out.push(mapListing(r));
    if (page.length < limit) break;
  }
  return out;
}

export function mapListing(r: any): Listing {
  const hoa = r.hoa?.fee;
  return {
    id: r.id,
    address: r.addressLine1 + (r.addressLine2 ? ` ${r.addressLine2}` : ""),
    city: r.city,
    state: r.state,
    zip: r.zipCode,
    propertyType: r.propertyType,
    listingType: r.listingType,
    price: r.price,
    beds: r.bedrooms,
    baths: r.bathrooms,
    sqft: r.squareFootage,
    yearBuilt: r.yearBuilt,
    monthlyHoa: typeof hoa === "number" ? hoa : undefined,
    daysOnMarket: r.daysOnMarket,
    listedDate: r.listedDate,
    agentName: r.listingAgent?.name,
    agentPhone: r.listingAgent?.phone,
    agentEmail: r.listingAgent?.email,
    officeName: r.listingOffice?.name,
  };
}

export async function fetchRent(l: Listing, key: string) {
  const params: Record<string, string | number> = {
    address: `${l.address}, ${l.city}, ${l.state} ${l.zip}`,
    propertyType: l.propertyType,
  };
  if (l.beds != null) params.bedrooms = l.beds;
  if (l.baths != null) params.bathrooms = l.baths;
  if (l.sqft != null) params.squareFootage = l.sqft;
  const r = await get("/avm/rent/long-term", params, key);
  if (!r?.rent) return null;
  return { rent: r.rent as number, low: r.rentRangeLow as number, high: r.rentRangeHigh as number };
}

// What the house is worth (RentCast value AVM). Used as the after-repair value for flips.

export async function fetchValue(l: Listing, key: string): Promise<number | undefined> {
  const params: Record<string, string | number> = {
    address: `${l.address}, ${l.city}, ${l.state} ${l.zip}`,
    propertyType: l.propertyType,
  };
  if (l.beds != null) params.bedrooms = l.beds;
  if (l.baths != null) params.bathrooms = l.baths;
  if (l.sqft != null) params.squareFootage = l.sqft;
  const r = await get("/avm/value", params, key);
  return r?.price ?? undefined;
}

// Latest year's tax bill from the county record. Also catches HOA the listing didn't show.
export async function fetchTaxAndHoa(l: Listing, key: string) {
  const r = await get("/properties", { address: `${l.address}, ${l.city}, ${l.state} ${l.zip}` }, key);
  const rec = Array.isArray(r) ? r[0] : r;
  if (!rec) return { tax: undefined, hoa: undefined };
  const years = Object.values(rec.propertyTaxes ?? {}) as { year: number; total: number }[];
  years.sort((a, b) => b.year - a.year);
  return { tax: years[0]?.total, hoa: rec.hoa?.fee as number | undefined };
}
