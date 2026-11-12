import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze, bufferFor, cashOnCash, monthlyMortgage } from "../src/deal.ts";
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
