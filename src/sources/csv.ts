// Load listings from a CSV (an MLS export, or a list typed up by hand).
// Header names are matched loosely; see README for the column list.
import { readFileSync } from "node:fs";
import type { Listing } from "./types.ts";

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}

const ALIASES: Record<string, string[]> = {
  address: ["address", "street", "streetaddress", "addressline1"],
  city: ["city"],
  state: ["state", "stateorprovince"],
  zip: ["zip", "zipcode", "postalcode"],
  propertyType: ["propertytype", "type"],
  price: ["price", "listprice", "listingprice"],
  beds: ["beds", "bedrooms", "bedroomstotal"],
  baths: ["baths", "bathrooms", "bathroomstotal"],
  sqft: ["sqft", "squarefootage", "livingarea"],
  monthlyHoa: ["hoa", "monthlyhoa", "associationfee"],
  monthlyRent: ["rent", "monthlyrent", "rentestimate"],
  rentLow: ["low", "rentlow"],
  rentHigh: ["high", "renthigh"],
  annualTax: ["tax", "taxes", "annualtax", "propertytax", "taxannualamount"],
  annualInsurance: ["insurance", "annualinsurance"],
  value: ["value", "arv", "valueestimate"],
  daysOnMarket: ["dom", "daysonmarket"],
  agentName: ["agent", "agentname", "listagent", "listagentfullname"],
  agentPhone: ["agentphone", "phone", "listagentphone", "listagentdirectphone"],
  agentEmail: ["agentemail", "email", "listagentemail"],
  url: ["url", "link", "zillow"],
};
const NUMERIC = new Set(["price", "beds", "baths", "sqft", "monthlyHoa", "monthlyRent", "rentLow", "rentHigh", "annualTax", "annualInsurance", "value", "daysOnMarket"]);

export function loadCsv(path: string): Listing[] {
  const [header, ...rows] = parseCsv(readFileSync(path, "utf8"));
  const norm = header.map((h) => h.toLowerCase().replace(/[^a-z0-9]/g, ""));
  const col: Record<string, number> = {};
  for (const [field, names] of Object.entries(ALIASES)) {
    const i = norm.findIndex((h) => names.includes(h));
    if (i >= 0) col[field] = i;
  }
  for (const req of ["address", "city", "state", "price"]) {
    if (col[req] == null) throw new Error(`CSV is missing a "${req}" column`);
  }
  return rows.map((r, idx) => {
    const l: any = { id: `csv-${idx}` };
    for (const [field, i] of Object.entries(col)) {
      const raw = (r[i] ?? "").trim();
      if (!raw) continue;
      l[field] = NUMERIC.has(field) ? Number(raw.replace(/[$,]/g, "")) : raw;
    }
    l.zip ??= "";
    l.propertyType ??= "Single Family";
    l.id = `csv-${l.address}-${l.zip}`.toLowerCase().replace(/\s+/g, "-");
    return l as Listing;
  });
}
