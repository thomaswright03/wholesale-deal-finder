// The rental deal math from the call. Everything is "first year" numbers.
//
// Question we answer for every listing:
//   What is the most an end buyer can pay and still get a 20% cash-on-cash
//   return in year one, AND still be buying at least $X under list price?
//   Then: can we get it under contract low enough to keep our assignment fee?

export interface BuyerAssumptions {
  interestRate: number; // 0.076 = 7.6%, 30-year fixed
  loanYears: number;
  downPayment: number; // 0.20
  closingCosts: number; // 0.03 of purchase price
  managementAndUpkeep: number; // 0.20 of rent goes to property management / repairs
  minCashOnCash: number; // 0.20
  insuranceMinAnnual: number; // landlord policy floor, $/yr
  insurancePctOfPrice: number; // landlord policy estimate as % of list price
}

export interface OfferRules {
  floorPctOfList: number; // 0.70 -> first offer is 70% of list
  minAssignmentFee: number; // our cut, $
  buffers: { upTo: number; discount: number }[]; // buyer must buy at least this far under list
}

export interface PropertyNumbers {
  listPrice: number;
  monthlyRent: number; // market median rent
  annualTax: number;
  annualInsurance?: number; // if unknown we estimate a landlord policy
  monthlyHoa?: number;
}

export interface DealResult {
  listPrice: number;
  monthlyRent: number;
  annualTax: number;
  annualInsurance: number;
  insuranceEstimated: boolean;
  buffer: number;
  maxPriceFor20pct: number; // highest price where buyer still hits min CoC
  buyerMaxPrice: number; // min(maxPriceFor20pct, list - buffer)
  ceilingOffer: number; // buyerMaxPrice - our assignment fee
  floorOffer: number; // 70% of list
  feeAtFloor: number; // what we make if seller takes the floor offer and buyer pays buyerMaxPrice
  // Buyer's year one at buyerMaxPrice
  buyerMonthlyMortgage: number;
  buyerCashInvested: number;
  buyerAnnualCashFlow: number;
  buyerCashOnCash: number;
  qualifies: boolean;
  tier: "A" | "B" | "C" | null;
  reason: string;
}

export function monthlyMortgage(price: number, a: BuyerAssumptions): number {
  const loan = price * (1 - a.downPayment);
  const r = a.interestRate / 12;
  const n = a.loanYears * 12;
  if (loan <= 0) return 0;
  if (r === 0) return loan / n;
  return (loan * r) / (1 - Math.pow(1 + r, -n));
}

export function annualCashFlow(price: number, p: Required<PropertyNumbers>, a: BuyerAssumptions): number {
  const netRent = p.monthlyRent * (1 - a.managementAndUpkeep);
  const monthly = netRent - monthlyMortgage(price, a) - p.annualTax / 12 - p.annualInsurance / 12 - p.monthlyHoa;
  return monthly * 12;
}

export function cashInvested(price: number, a: BuyerAssumptions): number {
  return price * (a.downPayment + a.closingCosts);
}

export function cashOnCash(price: number, p: Required<PropertyNumbers>, a: BuyerAssumptions): number {
  return annualCashFlow(price, p, a) / cashInvested(price, a);
}

export function bufferFor(listPrice: number, rules: OfferRules): number {
  const sorted = [...rules.buffers].sort((x, y) => x.upTo - y.upTo);
  for (const b of sorted) if (listPrice < b.upTo) return b.discount;
  return sorted[sorted.length - 1]?.discount ?? 0;
}

export function estimateInsurance(listPrice: number, a: BuyerAssumptions): number {
  return Math.max(a.insuranceMinAnnual, listPrice * a.insurancePctOfPrice);
}

// Cash-on-cash falls as price rises, so bisect for the highest price that still hits the target.
export function maxPriceForCoc(p: Required<PropertyNumbers>, a: BuyerAssumptions): number {
  let lo = 1;
  let hi = p.listPrice * 2;
  if (cashOnCash(lo, p, a) < a.minCashOnCash) return 0;
  if (cashOnCash(hi, p, a) >= a.minCashOnCash) return hi;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (cashOnCash(mid, p, a) >= a.minCashOnCash) lo = mid;
    else hi = mid;
  }
  return lo;
}

const round = (n: number, to = 1) => Math.round(n / to) * to;

export function analyze(input: PropertyNumbers, a: BuyerAssumptions, rules: OfferRules): DealResult {
  const insuranceEstimated = input.annualInsurance == null;
  const p: Required<PropertyNumbers> = {
    listPrice: input.listPrice,
    monthlyRent: input.monthlyRent,
    annualTax: input.annualTax,
    annualInsurance: input.annualInsurance ?? estimateInsurance(input.listPrice, a),
    monthlyHoa: input.monthlyHoa ?? 0,
  };
  const buffer = bufferFor(p.listPrice, rules);
  const maxPriceFor20pct = round(maxPriceForCoc(p, a), 100);
  const buyerMaxPrice = Math.max(0, Math.min(maxPriceFor20pct, p.listPrice - buffer));
  const ceilingOffer = round(buyerMaxPrice - rules.minAssignmentFee, 100);
  const floorOffer = round(p.listPrice * rules.floorPctOfList, 100);
  const feeAtFloor = buyerMaxPrice - floorOffer;

  const cf = annualCashFlow(buyerMaxPrice, p, a);
  const inv = cashInvested(buyerMaxPrice, a);

  let qualifies = ceilingOffer >= floorOffer && buyerMaxPrice > 0;
  let reason: string;
  if (maxPriceFor20pct === 0) {
    qualifies = false;
    reason = "Rent can't cover expenses for a 20% return at any price";
  } else if (!qualifies) {
    reason = `Buyer tops out at $${fmt(buyerMaxPrice)}; minus our $${fmt(rules.minAssignmentFee)} fee that's below the 70% floor of $${fmt(floorOffer)}`;
  } else if (maxPriceFor20pct < p.listPrice - buffer) {
    reason = `Cash flow limits the buyer to $${fmt(buyerMaxPrice)}`;
  } else {
    reason = `Buyer limited by the $${fmt(buffer)} under-list buffer to $${fmt(buyerMaxPrice)}`;
  }

  // Tier by how much room there is between our floor and ceiling offers, as a share of list.
  // A: lots of room (big fee possible). B: decent. C: barely works.
  let tier: DealResult["tier"] = null;
  if (qualifies) {
    const room = (ceilingOffer - floorOffer) / p.listPrice;
    tier = room >= 0.1 ? "A" : room >= 0.04 ? "B" : "C";
  }

  return {
    listPrice: p.listPrice,
    monthlyRent: p.monthlyRent,
    annualTax: round(p.annualTax),
    annualInsurance: round(p.annualInsurance),
    insuranceEstimated,
    buffer,
    maxPriceFor20pct,
    buyerMaxPrice: round(buyerMaxPrice, 100),
    ceilingOffer,
    floorOffer,
    feeAtFloor: round(feeAtFloor, 100),
    buyerMonthlyMortgage: round(monthlyMortgage(buyerMaxPrice, a)),
    buyerCashInvested: round(inv),
    buyerAnnualCashFlow: round(cf),
    buyerCashOnCash: inv > 0 ? Math.round((cf / inv) * 1000) / 1000 : 0,
    qualifies,
    tier,
    reason,
  };
}

function fmt(n: number) {
  return Math.round(n).toLocaleString("en-US");
}
