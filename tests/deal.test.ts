import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze, bufferFor, cashOnCash, dealType, flipProfit, monthlyMortgage } from "../src/deal.ts";
import { evaluate } from "../src/run.ts";
import { loadCsv } from "../src/sources/csv.ts";
import { readFileSync } from "node:fs";

const cfg = JSON.parse(readFileSync(new URL("../config.json", import.meta.url), "utf8"));
const a = cfg.buyer, rules = cfg.offer;

test("mortgage matches a standard calculator", () => {
  // $100k, 20% down, 7.6%, 30yr -> $80k loan -> ~$564.86/mo
  assert.equal(Math.round(monthlyMortgage(100000, a) * 100) / 100, 564.86);
});

test("buffer picks the right band", () => {
  assert.equal(bufferFor(66900, rules), 12000);
  assert.equal(bufferFor(150000, rules), 20000);
  assert.equal(bufferFor(225000, rules), 25000);
  assert.equal(bufferFor(299000, rules), 30000);
});

test("buyer max price hits exactly the 20% target or the buffer", () => {
  const d = analyze({ listPrice: 66900, monthlyRent: 1450, annualTax: 2400 }, a, rules);
  // Cheap Cincinnati house: buffer is the binding limit, buyer return is well over 20%
  assert.equal(d.buyerMaxPrice, 54900);
  assert.ok(d.buyerCashOnCash > 0.2);
  assert.equal(d.floorOffer, 46800);
  assert.equal(d.ceilingOffer, 46900);
  assert.ok(d.qualifies);

  const tight = analyze({ listPrice: 280000, monthlyRent: 2100, annualTax: 5600 }, a, rules);
  assert.equal(tight.qualifies, false);
  const p = { listPrice: 280000, monthlyRent: 2100, annualTax: 5600, annualInsurance: tight.annualInsurance, monthlyHoa: 0 };
  // at the solved price the return is ~20%
  if (tight.maxPriceFor20pct > 0) assert.ok(Math.abs(cashOnCash(tight.maxPriceFor20pct, p, a) - 0.2) < 0.002);
});

test("sample CSV end to end", () => {
  const listings = loadCsv(new URL("./sample.csv", import.meta.url).pathname);
  const { leads, rejected } = evaluate(listings, cfg, "2026-11-12", () => "2026-11-12");
  const why = Object.fromEntries(rejected.map((r) => [r.l.address, r.reason]));
  assert.equal(why["400 Example St"], "Has an HOA");
  assert.equal(why["500 Example St"], "Property type Condo");
  assert.ok(leads.some((l) => l.address === "6823 Betts Ave"));
  for (const l of leads) assert.ok(l.deal.ceilingOffer >= l.deal.floorOffer);
});

test("rental vs flip and flip profit", () => {
  assert.equal(dealType(66900, 105000, cfg.flip), "Flip"); // 64% of value
  assert.equal(dealType(120000, 140000, cfg.flip), "Rental"); // 86% of value
  assert.equal(dealType(120000, undefined, cfg.flip), null);
  // $105k ARV, buyer pays $54,900, 1,100 sqft x $30 = $33,000 rehab, 10% costs = $10,500
  assert.deepEqual(flipProfit(105000, 54900, 1100, cfg.flip), { rehab: 33000, profit: 6600 });
});

test("photo rating: folder name, request shape, and how a rating changes the lead", async () => {
  const { photoFolderName, listPhotos, rateHouse } = await import("../src/photos.ts");
  const { applyRating } = await import("../src/run.ts");
  const listing: any = { id: "x", address: "6823 Betts Ave", city: "Cincinnati", state: "OH", zip: "45239", propertyType: "Single Family", price: 66900, beds: 3, baths: 1, sqft: 1100 };
  assert.equal(photoFolderName(listing), "6823-Betts-Ave-Cincinnati-OH-45239");
  const files = listPhotos(new URL("./photos/6823-Betts-Ave-Cincinnati-OH-45239", import.meta.url).pathname, 10);
  assert.equal(files.length, 3);

  let sent: any;
  const fake: any = { messages: { parse: async (p: any) => { sent = p; return { stop_reason: "end_turn", parsed_output: { condition: "medium_rehab", rehab_estimate: 30000, confidence: "medium", notes: "Dated kitchen.", rooms_seen: ["kitchen"] } }; } } };
  const r = await rateHouse(fake, listing, files, cfg.photos);
  assert.equal(sent.model, cfg.photos.model);
  assert.equal(sent.messages[0].content.filter((b: any) => b.type === "image").length, 3);
  assert.ok(sent.output_config.format);
  assert.equal(r!.condition, "medium_rehab");

  const deal = analyze({ listPrice: 66900, monthlyRent: 1450, annualTax: 2400 }, a, rules);
  const lead: any = { ...listing, value: 105000, deal, dealType: "Rental" };
  applyRating(lead, r!, cfg);
  assert.equal(lead.dealType, "Flip");
  // 105,000 - 54,900 - 30,000 - 10,500
  assert.equal(lead.flipProfit, 9600);
  applyRating(lead, { ...r!, condition: "rental_ready" }, cfg);
  assert.equal(lead.dealType, "Rental");
  assert.equal(lead.flipProfit, undefined);
});
