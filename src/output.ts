import { readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import ExcelJS from "exceljs";
import type { DealResult } from "./deal.ts";
import type { Listing } from "./sources/types.ts";
import type { Lead } from "./run.ts";
import { conditionLabel } from "./photos.ts";

export function zillowUrl(l: Listing) {
  if (l.url) return l.url;
  const slug = `${l.address} ${l.city} ${l.state} ${l.zip}`.trim().replace(/[^A-Za-z0-9]+/g, "-");
  return `https://www.zillow.com/homes/${slug}_rb/`;
}

const money = '"$"#,##0';
const pct = "0.0%";

export async function writeSpreadsheet(
  path: string,
  leads: Lead[],
  rejected: { l: Listing; reason: string; deal?: DealResult }[],
  cfg: any,
) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Leads", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = [
    { header: "Tier", key: "tier", width: 6 },
    { header: "New today", key: "isNew", width: 9 },
    { header: "Address", key: "address", width: 28 },
    { header: "Beds", key: "beds", width: 6 },
    { header: "Baths", key: "baths", width: 6 },
    { header: "Sqft", key: "sqft", width: 7 },
    { header: "Days on market", key: "dom", width: 9 },
    { header: "List price", key: "list", width: 11, style: { numFmt: money } },
    { header: "Floor offer (70%)", key: "floor", width: 12, style: { numFmt: money } },
    { header: "Ceiling offer", key: "ceiling", width: 12, style: { numFmt: money } },
    { header: "Buyer max price", key: "buyerMax", width: 12, style: { numFmt: money } },
    { header: "Your fee at floor", key: "fee", width: 12, style: { numFmt: money } },
    { header: "Median rent /mo", key: "rent", width: 11, style: { numFmt: money } },
    { header: "Property tax /yr", key: "tax", width: 11, style: { numFmt: money } },
    { header: "Insurance /yr (est.)", key: "ins", width: 11, style: { numFmt: money } },
    { header: "Buyer mortgage /mo", key: "pi", width: 11, style: { numFmt: money } },
    { header: "Buyer cash in", key: "inv", width: 11, style: { numFmt: money } },
    { header: "Buyer cash flow /yr", key: "cf", width: 11, style: { numFmt: money } },
    { header: "Deal type", key: "type", width: 9 },
    { header: "Rental: buyer cash-on-cash", key: "coc", width: 12, style: { numFmt: pct } },
    { header: "Flip: buyer profit", key: "flip", width: 12, style: { numFmt: money } },
    { header: "Value / ARV", key: "arv", width: 11, style: { numFmt: money } },
    { header: "Flip rehab (est.)", key: "rehab", width: 11, style: { numFmt: money } },
    { header: "Condition (from photos)", key: "cond", width: 14 },
    { header: "Rehab estimate (photos)", key: "prehab", width: 12, style: { numFmt: '"$"#,##0' } },
    { header: "Rehab range", key: "rrange", width: 18 },
    { header: "Rehab breakdown (Home Restoration AI)", key: "rlines", width: 60 },
    { header: "Photo confidence", key: "conf", width: 10 },
    { header: "Photo notes", key: "pnotes", width: 50 },
    { header: "Photo folder", key: "pfolder", width: 40 },
    { header: "Agent", key: "agent", width: 20 },
    { header: "Agent phone", key: "phone", width: 14 },
    { header: "Agent email", key: "email", width: 24 },
    { header: "Listing", key: "link", width: 10 },
    { header: "Notes", key: "notes", width: 30 },
    { header: "City", key: "city", width: 14 },
    { header: "State", key: "state", width: 6 },
    { header: "Zip", key: "zip", width: 8 },
    { header: "Type", key: "propertyType", width: 13 },
  ];
  for (const l of leads) {
    const d = l.deal;
    const notes = [l.rentSource?.includes("duplex") ? `Rent assumes a duplex (2 x HUD 2-bed for ${l.zip}); confirm the unit count before calling. Capped at tier B` : l.rentSource?.startsWith("HUD") ? `Rent is ${l.rentSource} for ${l.zip} (conservative; check comps)` : "", l.taxEstimated ? "Tax estimated (no county record)" : "", d.reason].filter(Boolean).join(". ");
    const row = ws.addRow({
      tier: d.tier, isNew: l.isNew ? "Yes" : "", address: l.address, city: l.city, state: l.state, zip: l.zip,
      propertyType: l.propertyType, beds: l.beds, baths: l.baths, sqft: l.sqft, dom: l.daysOnMarket,
      list: d.listPrice, floor: d.floorOffer, ceiling: d.ceilingOffer, buyerMax: d.buyerMaxPrice, fee: d.feeAtFloor,
      rent: d.monthlyRent, tax: d.annualTax, ins: d.annualInsurance, pi: d.buyerMonthlyMortgage,
      inv: d.buyerCashInvested, cf: d.buyerAnnualCashFlow,
      type: l.dealType ?? "Unknown",
      coc: l.dealType === "Flip" ? null : d.buyerCashOnCash,
      flip: l.dealType === "Flip" ? l.flipProfit : null,
      arv: l.value, rehab: l.dealType === "Flip" ? l.flipRehab : null,
      cond: l.condition ? conditionLabel(l.condition.condition) : "Not rated",
      prehab: l.condition ? Math.round(l.condition.rehab_estimate) : undefined,
      rrange: l.condition?.rehab_low ? `$${l.condition.rehab_low.toLocaleString("en-US")} - $${l.condition.rehab_high!.toLocaleString("en-US")}` : undefined,
      rlines: l.condition?.rehab_lines?.map((x) => `${x.label} $${x.cost.toLocaleString("en-US")}`).join("; "),
      conf: l.condition?.confidence, pnotes: l.condition?.notes, pfolder: l.photoFolder ? `photos/${l.photoFolder}/` : "",
      agent: l.agentName, phone: l.agentPhone, email: l.agentEmail,
      link: { text: "Open", hyperlink: zillowUrl(l) }, notes,
    });
    const fill = d.tier === "A" ? "FFD9F2D0" : d.tier === "B" ? "FFFFF2CC" : "FFF2F2F2";
    row.getCell("tier").fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } };
  }
  ws.getRow(1).font = { bold: true };
  ws.autoFilter = { from: "A1", to: { row: 1, column: ws.columns.length } };

  const rj = wb.addWorksheet("Skipped");
  rj.columns = [
    { header: "Address", key: "a", width: 28 }, { header: "City", key: "c", width: 14 }, { header: "State", key: "s", width: 6 },
    { header: "List price", key: "p", width: 11, style: { numFmt: money } },
    { header: "Median rent", key: "r", width: 11, style: { numFmt: money } },
    { header: "Buyer max price", key: "b", width: 12, style: { numFmt: money } },
    { header: "Why skipped", key: "why", width: 70 },
  ];
  for (const { l, reason, deal } of rejected) {
    rj.addRow({ a: l.address, c: l.city, s: l.state, p: l.price, r: l.monthlyRent, b: deal?.buyerMaxPrice, why: reason });
  }
  rj.getRow(1).font = { bold: true };

  const a = wb.addWorksheet("Assumptions");
  a.columns = [{ header: "Setting", key: "k", width: 36 }, { header: "Value", key: "v", width: 20 }];
  const b = cfg.buyer, o = cfg.offer;
  const rows: [string, string][] = [
    ["Mortgage rate (30-yr fixed)", `${(b.interestRate * 100).toFixed(2)}%`],
    ["Mortgage rate source", cfg.rateSource ?? "config.json"],
    ["Buyer down payment", `${b.downPayment * 100}%`],
    ["Buyer closing costs", `${b.closingCosts * 100}% of price`],
    ["Management + upkeep", `${b.managementAndUpkeep * 100}% of rent`],
    ["Minimum buyer cash-on-cash", `${b.minCashOnCash * 100}%`],
    ["Landlord insurance estimate", `greater of $${b.insuranceMinAnnual} or ${b.insurancePctOfPrice * 100}% of price`],
    ["Floor offer", `${o.floorPctOfList * 100}% of list`],
    ["Minimum assignment fee", `$${o.minAssignmentFee.toLocaleString()}`],
    ...o.buffers.map((x: any, i: number, arr: any[]) => [
      `Buyer discount under list, ${i === 0 ? "under" : `$${(arr[i - 1].upTo / 1000)}k to`} $${x.upTo >= 1e8 ? "300k+" : x.upTo / 1000 + "k"}`,
      `$${x.discount.toLocaleString()}`,
    ] as [string, string]),
  ];
  for (const [k, v] of rows) a.addRow({ k, v });
  a.getRow(1).font = { bold: true };

  await wb.xlsx.writeFile(path);
}

// The card page reuses src/deal.ts (types stripped) so a rent you type in recalculates with the exact same math.
function dealMathJs() {
  const ts = readFileSync(new URL("./deal.ts", import.meta.url), "utf8");
  return stripTypeScriptTypes(ts).replace(/^export /gm, "");
}

export function writeCards(path: string, leads: Lead[], date: string, cfg: any) {
  const data = leads.map((l) => ({
    id: l.id, tier: l.deal.tier, isNew: l.isNew, address: l.address, city: l.city, state: l.state, zip: l.zip,
    type: l.propertyType, beds: l.beds, baths: l.baths, sqft: l.sqft, dom: l.daysOnMarket,
    agent: l.agentName, phone: l.agentPhone, email: l.agentEmail, url: zillowUrl(l), taxEstimated: l.taxEstimated,
    rentLow: l.rentLow, rentHigh: l.rentHigh, hoa: l.monthlyHoa ?? 0, dealType: l.dealType, flipProfit: l.flipProfit, flipRehab: l.flipRehab, arv: l.value, cond: l.condition ? conditionLabel(l.condition.condition) : null, condConf: l.condition?.confidence, condRehab: l.condition ? Math.round(l.condition.rehab_estimate) : null, rentSource: l.rentSource ?? "", condLines: l.condition?.rehab_lines?.map((x) => x.label + " $" + x.cost.toLocaleString("en-US")).join(" · ") ?? "", condNotes: l.condition?.notes, ...l.deal,
  }));
  const json = (x: unknown) => JSON.stringify(x).replace(/</g, "\\u003c");
  const html = CARD_HTML.replace("__DATE__", () => date)
    .replace("__DEAL_MATH__", () => dealMathJs())
    .replace("__CFG__", () => json({ buyer: cfg.buyer, offer: cfg.offer }))
    .replace("__DATA__", () => json(data));
  writeFileSync(path, html);
}

const CARD_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Deal Cards</title>
<style>
:root{--bg:#f6f5f2;--card:#fff;--ink:#1d1d1b;--muted:#6b6a66;--line:#e4e2dc;--a:#1f7a4d;--b:#b7791f;--c:#6b6a66;--accent:#2f5bd3}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--card:#21211f;--ink:#f1efe9;--muted:#a3a19a;--line:#33322f;--accent:#7d9cff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 -apple-system,system-ui,sans-serif}
header{padding:20px 16px 8px;max-width:760px;margin:auto}h1{font-size:22px;margin:0}
.sub{color:var(--muted);font-size:13px}
.bar{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
.bar button{border:1px solid var(--line);background:var(--card);color:var(--ink);padding:6px 12px;border-radius:999px;cursor:pointer;font-size:13px}
.bar button.on{background:var(--ink);color:var(--bg)}
main{max-width:760px;margin:auto;padding:8px 16px 60px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;margin:12px 0}
.card.done{opacity:.5}
.top{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}
.addr{font-weight:600;font-size:17px}.meta{color:var(--muted);font-size:13px}
.tier{font-weight:700;border-radius:8px;padding:2px 9px;color:#fff;font-size:13px}
.tA{background:var(--a)}.tB{background:var(--b)}.tC{background:var(--c)}
.new{font-size:11px;border:1px solid var(--accent);color:var(--accent);border-radius:6px;padding:1px 6px;margin-left:6px}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:14px 0}
.grid div{background:var(--bg);border-radius:10px;padding:8px 10px}.grid b{display:block;font-size:16px}
.grid span{color:var(--muted);font-size:12px}
details{font-size:13px;color:var(--muted)}details table{width:100%;border-collapse:collapse;margin-top:6px}
details td{padding:3px 0;border-bottom:1px solid var(--line)}details td:last-child{text-align:right;color:var(--ink)}
.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
.actions a,.actions button{flex:1;min-width:90px;text-align:center;text-decoration:none;border-radius:10px;padding:9px;border:1px solid var(--line);background:var(--card);color:var(--ink);font-size:14px;cursor:pointer}
.actions .call{background:var(--accent);color:#fff;border-color:var(--accent)}
.status{font-size:13px;color:var(--muted);margin-top:8px}
.rentrow{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap}.rentrow input{flex:1;min-width:120px;border:1px solid var(--line);border-radius:10px;padding:8px;background:var(--bg);color:var(--ink);font:inherit}
.rentrow button{border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:10px;padding:8px 12px;cursor:pointer;font-size:14px}
.cond{margin-top:10px;padding:8px 10px;border-radius:8px;background:var(--bg);font-size:14px}.cond .sub{font-size:12px}
.warn{margin-top:10px;padding:8px 10px;border-radius:8px;background:#fde8e4;color:#8a2c1c;font-size:13px}
textarea{width:100%;margin-top:8px;border:1px solid var(--line);border-radius:8px;padding:8px;background:var(--bg);color:var(--ink);font:inherit;font-size:13px}
@media (max-width:520px){.grid{grid-template-columns:repeat(2,1fr)}}
</style></head><body>
<header><h1>Deal cards</h1><div class="sub">Run of __DATE__ · <span id="count"></span></div>
<div class="bar" id="filters"></div></header>
<main id="list"></main>
<script>
__DEAL_MATH__
const CFG = __CFG__;
const DATA = __DATA__;
const ZILLOW_RENT = "https://www.zillow.com/rental-manager/price-my-rental/";
const $ = (n)=>"$"+Math.round(n||0).toLocaleString();
const KEY = "deal-status";
let state = {}; try { state = JSON.parse(localStorage.getItem(KEY)||"{}") } catch {}
const save = ()=>{ try { localStorage.setItem(KEY, JSON.stringify(state)) } catch {} };
let filter = "todo";
const FILTERS = [["todo","To contact"],["A","Tier A"],["B","Tier B"],["C","Tier C"],["new","New today"],["done","Contacted / skipped"],["all","All"]];
function shown(d){ const s=state[d.id]?.status;
  if(filter==="todo") return !s; if(filter==="done") return !!s; if(filter==="new") return d.isNew; if(filter==="all") return true; return d.tier===filter; }
function smsBody(d){ return "Hi"+(d.agent?" "+d.agent.split(" ")[0]:"")+", I'm an investor interested in "+d.address+". Would your seller consider a cash offer around "+$(d.floorOffer)+" with a quick close?"; }
function render(){
  const list=document.getElementById("list"); const items=DATA.filter(shown);
  document.getElementById("count").textContent = DATA.length+" leads, "+DATA.filter(d=>!state[d.id]?.status).length+" not contacted";
  document.getElementById("filters").innerHTML = FILTERS.map(([k,l])=>'<button data-f="'+k+'" class="'+(k===filter?"on":"")+'">'+l+'</button>').join("");
  list.innerHTML = items.length ? "" : '<p class="sub">Nothing here.</p>';
  for(let d of items){
    const s=state[d.id]||{};
    const base=d; if(s.rent){ d={...base,...analyze({listPrice:base.listPrice,monthlyRent:s.rent,annualTax:base.annualTax,annualInsurance:base.annualInsurance,monthlyHoa:base.hoa},CFG.buyer,CFG.offer)}; }
    const el=document.createElement("div"); el.className="card"+(s.status?" done":"");
    const phone=(d.phone||"").replace(/[^0-9+]/g,"");
    el.innerHTML = '<div class="top"><div><div class="addr"></div><div class="meta"></div></div><span class="tier t'+(d.tier||"C")+'">'+(d.tier||"Out")+'</span></div>'+
      '<div class="grid"><div><span>List</span><b>'+$(d.listPrice)+'</b></div><div><span>Offer from</span><b>'+$(d.floorOffer)+'</b></div><div><span>Offer up to</span><b>'+$(d.ceilingOffer)+'</b></div>'+
      '<div><span>Buyer pays up to</span><b>'+$(d.buyerMaxPrice)+'</b></div><div><span>Your fee at floor</span><b>'+$(d.feeAtFloor)+'</b></div><div><span>Rent'+(s.rent?' (yours)':(d.rentSource?' ('+d.rentSource+')':''))+'</span><b>'+$(d.monthlyRent)+'/mo</b></div>'+
      '<div><span>Deal type</span><b>'+(d.dealType||"Unknown")+'</b></div>'+
      (d.dealType==="Flip"?'<div><span>Flip: buyer profit</span><b>'+$(d.flipProfit)+'</b></div><div><span>Value / ARV</span><b>'+$(d.arv)+'</b></div>':'<div><span>Rental: cash-on-cash</span><b>'+(d.buyerCashOnCash*100).toFixed(1)+'%</b></div><div><span>Value / ARV</span><b>'+(d.arv?$(d.arv):"n/a")+'</b></div>')+'</div>'+
      (s.rent&&!d.qualifies?'<div class="warn">With this rent it no longer works: '+d.reason+'</div>':'')+
      '<div class="rentrow"><button class="zr">Check rent on Zillow</button><input type="number" inputmode="numeric" placeholder="Zillow median rent" value="'+(s.rent||"")+'"><button class="clr">Reset</button></div>'+
      (d.cond?'<div class="cond"><b>'+d.cond+'</b>'+(d.condRehab!=null?' · about '+$(d.condRehab)+' rehab':'')+' <span class="sub">('+d.condConf+' confidence, from photos)</span><div class="sub cn"></div></div>':'')+
      '<details><summary>Buyer numbers at '+$(d.buyerMaxPrice)+'</summary><table>'+
      '<tr><td>Mortgage (P&amp;I)</td><td>'+$(d.buyerMonthlyMortgage)+'/mo</td></tr>'+
      '<tr><td>Property tax'+(d.taxEstimated?" (estimated)":"")+'</td><td>'+$(d.annualTax)+'/yr</td></tr>'+
      '<tr><td>Landlord insurance (estimated)</td><td>'+$(d.annualInsurance)+'/yr</td></tr>'+
      '<tr><td>Rent range</td><td>'+(d.rentLow?$(d.rentLow)+" to "+$(d.rentHigh):"n/a")+'</td></tr>'+
      '<tr><td>Cash in (down + closing)</td><td>'+$(d.buyerCashInvested)+'</td></tr>'+
      '<tr><td>Year one cash flow</td><td>'+$(d.buyerAnnualCashFlow)+'</td></tr>'+
      '<tr><td>Cash-on-cash</td><td>'+(d.buyerCashOnCash*100).toFixed(1)+'%</td></tr></table></details>'+
      '<div class="actions">'+(phone?'<a class="call" href="tel:'+phone+'">Call</a><a class="sms" href="sms:'+phone+'&body='+encodeURIComponent(smsBody(d))+'">Text</a>':'')+
      '<a href="'+d.url+'" target="_blank" rel="noopener">Photos</a><button data-s="contacted">Contacted</button><button data-s="skip">Skip</button></div>'+
      '<div class="status"></div><textarea rows="2" placeholder="Notes"></textarea>';
    el.querySelector(".addr").textContent = d.address;
    if(d.cond) el.querySelector(".cn").textContent = (d.condLines ? d.condLines + ". " : "") + (d.condNotes||"");
    el.querySelector(".meta").innerHTML = '';
    el.querySelector(".meta").append(d.city+", "+d.state+" "+(d.zip||"")+" · "+[d.type,d.beds&&d.beds+" bd",d.baths&&d.baths+" ba",d.sqft&&d.sqft.toLocaleString()+" sqft",d.dom!=null&&d.dom+" days listed"].filter(Boolean).join(" · ")+(d.agent?" · "+d.agent:""));
    if(d.isNew){const n=document.createElement("span");n.className="new";n.textContent="NEW";el.querySelector(".addr").append(n)}
    el.querySelector(".status").textContent = s.status ? (s.status==="skip"?"Skipped":"Contacted")+" "+s.at : "";
    el.querySelector(".zr").onclick=()=>{ const a=d.address+", "+d.city+", "+d.state+" "+(d.zip||""); try{navigator.clipboard.writeText(a)}catch{} window.open(ZILLOW_RENT,"_blank","noopener"); el.querySelector(".zr").textContent="Address copied, paste it on Zillow"; };
    const ri=el.querySelector(".rentrow input"); ri.onchange=()=>{ const v=Number(ri.value); state[d.id]={...state[d.id],rent:v>0?v:undefined}; save(); render(); };
    el.querySelector(".clr").onclick=()=>{ state[d.id]={...state[d.id],rent:undefined}; save(); render(); };
    const ta=el.querySelector("textarea"); ta.value=s.notes||""; ta.oninput=()=>{state[d.id]={...state[d.id],notes:ta.value};save()};
    el.querySelectorAll("[data-s]").forEach(b=>b.onclick=()=>{state[d.id]={...state[d.id],status:b.dataset.s,at:new Date().toLocaleDateString()};save();render()});
    list.append(el);
  }
}
document.getElementById("filters").onclick=(e)=>{const f=e.target.dataset?.f;if(f){filter=f;render()}};
render();
</script></body></html>`;
