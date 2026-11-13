// Home Restoration AI — whole-home restoration pricing.
//
// Prices a full house rehab (labor + materials, rental/investor grade) from
// a few facts about the house and a condition level for each area:
//
//   "none"   nothing to do
//   "light"  cosmetic / touch-up
//   "medium" partial replacement
//   "heavy"  full replacement / gut
//
// Bathrooms reuse the bathroom model (js/bathroom-pricing.js): a bathroom
// given with its room measurements and scope is priced line by line with
// computeEstimate() (labor) plus a materials allowance; a bathroom given
// only a level gets the flat allowance for that level.
//
// Every number lives in DEFAULT_HOME_PRICES and can be overridden per call
// (options.prices), so a business or investor can use their own. The
// defaults are rough Midwest rental-grade costs (2026), meant as a starting
// point, not a quote. regionFactor scales everything (1 = Midwest).
//
// Loads as a plain browser script (window.HomePricing, after
// js/bathroom-pricing.js) and as a Node module.

(function (/** @type {any} */ root, factory) {
  "use strict";
  var api = factory(root.BathroomPricing || (typeof require === "function" ? require("./bathroom-pricing.js") : null));
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.HomePricing = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (Bathroom) {
  "use strict";

  var LEVELS = ["none", "light", "medium", "heavy"];

  // Unit costs. Flat amounts are dollars per house (or per room where noted);
  // _PerSqFt amounts multiply the house's finished square feet unless noted.
  var DEFAULT_HOME_PRICES = {
    // Trash-out, dumpsters, haul-off.
    Cleanout: { light: 500, medium: 1500, heavy: 3500 },
    // Walls, ceilings and trim, per sq ft of floor area.
    Interior_Paint_Per_SqFt: { light: 1.5, medium: 2.75, heavy: 3.75 },
    // Drywall patching / replacement.
    Drywall_Flat_Light: 600,
    Drywall_Per_SqFt: { medium: 1.25, heavy: 3 },
    // Flooring: LVP/carpet installed with removal, on this share of the house.
    Flooring_Price_Per_SqFt: 5.5,
    Flooring_Share: { light: 0.25, medium: 0.6, heavy: 1 },
    // Kitchen: light = paint cabinets, hardware, faucet, backsplash;
    // medium = new counters + some cabinets; heavy = full rental-grade gut.
    Kitchen: { light: 3500, medium: 12000, heavy: 24000 },
    Appliances: { light: 900, medium: 1800, heavy: 3800 },
    // Bathroom allowance per full bath when no room details are given.
    Bathroom: { light: 1500, medium: 6500, heavy: 12500 },
    // Materials added on top of the bathroom model's labor (it is labor only).
    Bathroom_Materials: { light: 500, medium: 2500, heavy: 4500 },
    Interior_Door_Price: 275,
    Interior_Door_Share: { light: 0.25, medium: 0.5, heavy: 1 },
    Window_Price: 600,
    Window_Share: { light: 0.1, medium: 0.3, heavy: 1 },
    Exterior_Door_Price: 1100,
    Exterior_Doors: { light: 0, medium: 1, heavy: 2 },
    Exterior_Door_Hardware: 150,
    // Roof: repairs, or full tear-off at heavy (per sq ft of roof area).
    Roof_Repair: { light: 900, medium: 2800 },
    Roof_Replace_Per_SqFt: 5.75,
    // Exterior: touch-up, paint (per sq ft of wall), or new siding.
    Exterior_Touchup: 1200,
    Exterior_Paint_Per_WallSqFt: 2.5,
    Siding_Per_WallSqFt: 8,
    Hvac: { light: 350, medium: 4500, heavy: 9500 },
    Water_Heater: { light: 150, medium: 1700, heavy: 1700 },
    Electrical: { light: 600, medium: 2800 },
    Rewire_Per_SqFt: 7,
    Plumbing: { light: 500, medium: 3000 },
    Repipe_Per_SqFt: 5,
    Foundation: { light: 800, medium: 6000, heavy: 18000 },
    Landscaping: { light: 400, medium: 1500, heavy: 4000 },
  };

  // The areas, in the order they're asked for and listed.
  var AREAS = [
    { key: "cleanout", label: "Cleanout & haul-off", section: "Prep" },
    { key: "kitchen", label: "Kitchen", section: "Interior" },
    { key: "appliances", label: "Appliances", section: "Interior" },
    { key: "bathrooms", label: "Bathrooms", section: "Interior" },
    { key: "flooring", label: "Flooring", section: "Interior" },
    { key: "interiorPaint", label: "Interior paint", section: "Interior" },
    { key: "drywall", label: "Drywall", section: "Interior" },
    { key: "interiorDoors", label: "Interior doors & trim", section: "Interior" },
    { key: "windows", label: "Windows", section: "Exterior" },
    { key: "exteriorDoors", label: "Exterior doors", section: "Exterior" },
    { key: "roof", label: "Roof", section: "Exterior" },
    { key: "exterior", label: "Siding / exterior paint", section: "Exterior" },
    { key: "landscaping", label: "Yard & landscaping", section: "Exterior" },
    { key: "hvac", label: "Heating & cooling", section: "Systems" },
    { key: "waterHeater", label: "Water heater", section: "Systems" },
    { key: "electrical", label: "Electrical", section: "Systems" },
    { key: "plumbing", label: "Plumbing", section: "Systems" },
    { key: "foundation", label: "Foundation & structure", section: "Systems" },
  ];

  var DEFAULTS = { regionFactor: 1, permitsPct: 0.02, contingencyPct: 0.1 };

  function round(n) {
    return Math.round(Number(n) || 0);
  }

  function num(v, fallback) {
    var n = Number(v);
    return isFinite(n) && n > 0 ? n : fallback;
  }

  function level(v) {
    return LEVELS.indexOf(v) >= 0 ? v : "none";
  }

  function merge(base, over) {
    var out = {};
    Object.keys(base).forEach(function (k) {
      var b = base[k];
      var o = over && over[k];
      out[k] = b && typeof b === "object" && o && typeof o === "object" ? Object.assign({}, b, o) : o != null ? o : b;
    });
    return out;
  }

  // Rough geometry from finished sq ft and stories.
  function geometry(sqft, stories) {
    var footprint = sqft / stories;
    var perimeter = 4 * Math.sqrt(footprint) * 1.1; // houses aren't perfect squares
    return {
      footprint: footprint,
      roofSqFt: footprint * 1.15, // pitch and overhangs
      wallSqFt: perimeter * 9 * stories,
      windows: Math.max(4, Math.round(sqft / 100)),
    };
  }

  // One bathroom: { level, values?, scope? }. With values + scope it's priced
  // by the bathroom model (labor) plus the materials allowance.
  function priceBathroom(bath, prices, index) {
    var lv = level(bath && bath.level);
    var name = "Bathroom " + (index + 1) + (bath && bath.half ? " (half)" : "");
    var share = bath && bath.half ? 0.5 : 1;
    if (lv === "none") return null;
    if (Bathroom && bath.values && bath.scope) {
      var est = Bathroom.computeEstimate(bath.values, bath.scope, { includeTrade: true });
      var materials = prices.Bathroom_Materials[lv] * share;
      return {
        cost: round(est.total + materials),
        detail:
          "Room model: $" +
          round(est.total).toLocaleString("en-US") +
          " labor + $" +
          round(materials).toLocaleString("en-US") +
          " materials (" +
          lv +
          ")",
        label: name,
        breakdown: est.lines,
      };
    }
    return {
      cost: round(prices.Bathroom[lv] * share),
      detail: lv + " allowance" + (share < 1 ? ", half bath" : ""),
      label: name,
    };
  }

  // house: { sqft, stories, beds, baths, yearBuilt,
  //          areas: { <AREAS key>: "none"|"light"|"medium"|"heavy" },
  //          bathrooms: [{ level, half?, values?, scope? }] (optional; else
  //            areas.bathrooms applies to every bathroom in `baths`) }
  // options: { prices, regionFactor, permitsPct, contingencyPct }
  function computeHomeEstimate(house, options) {
    house = house || {};
    options = Object.assign({}, DEFAULTS, options || {});
    var prices = merge(DEFAULT_HOME_PRICES, options.prices);
    var sqft = num(house.sqft, 1200);
    var stories = Math.min(4, num(house.stories, 1));
    var beds = num(house.beds, 3);
    var baths = num(house.baths, 1);
    var areas = house.areas || {};
    var g = geometry(sqft, stories);
    var f = num(options.regionFactor, 1);
    var lines = [];
    var notes = [];

    function add(area, label, cost, detail) {
      cost = round(cost * f);
      if (cost <= 0) return;
      lines.push({ key: area.key, section: area.section, label: label, cost: cost, detail: detail });
    }
    function money(n) {
      return "$" + round(n).toLocaleString("en-US");
    }

    AREAS.forEach(function (area) {
      var lv = level(areas[area.key]);
      var p = prices;
      switch (area.key) {
        case "bathrooms": {
          var list = Array.isArray(house.bathrooms) && house.bathrooms.length ? house.bathrooms : null;
          if (!list) {
            list = [];
            for (var i = 0; i < Math.floor(baths); i++) list.push({ level: lv });
            if (baths % 1 >= 0.5) list.push({ level: lv, half: true });
          }
          list.forEach(function (b, idx) {
            var r = priceBathroom(b, p, idx);
            if (r) add(area, r.label, r.cost, r.detail);
          });
          return;
        }
        case "flooring":
          if (lv === "none") return;
          return add(
            area,
            area.label,
            sqft * p.Flooring_Share[lv] * p.Flooring_Price_Per_SqFt,
            Math.round(p.Flooring_Share[lv] * 100) +
              "% of " +
              round(sqft) +
              " sq ft at $" +
              p.Flooring_Price_Per_SqFt +
              "/sq ft",
          );
        case "interiorPaint":
          if (lv === "none") return;
          return add(
            area,
            area.label,
            sqft * p.Interior_Paint_Per_SqFt[lv],
            round(sqft) + " sq ft at $" + p.Interior_Paint_Per_SqFt[lv] + "/sq ft (" + lv + ")",
          );
        case "drywall":
          if (lv === "none") return;
          if (lv === "light") return add(area, area.label, p.Drywall_Flat_Light, "patching");
          return add(
            area,
            area.label,
            sqft * p.Drywall_Per_SqFt[lv],
            round(sqft) + " sq ft at $" + p.Drywall_Per_SqFt[lv] + "/sq ft",
          );
        case "interiorDoors": {
          if (lv === "none") return;
          var doors = Math.ceil((beds + Math.ceil(baths) + 3) * p.Interior_Door_Share[lv]);
          return add(
            area,
            area.label,
            doors * p.Interior_Door_Price,
            doors + " doors at " + money(p.Interior_Door_Price),
          );
        }
        case "windows": {
          if (lv === "none") return;
          var w = Math.ceil(g.windows * p.Window_Share[lv]);
          return add(
            area,
            area.label,
            w * p.Window_Price,
            w + " of ~" + g.windows + " windows at " + money(p.Window_Price),
          );
        }
        case "exteriorDoors":
          if (lv === "none") return;
          if (lv === "light") return add(area, area.label, p.Exterior_Door_Hardware * 2, "locks & hardware");
          return add(
            area,
            area.label,
            p.Exterior_Doors[lv] * p.Exterior_Door_Price,
            p.Exterior_Doors[lv] +
              " door" +
              (p.Exterior_Doors[lv] > 1 ? "s" : "") +
              " at " +
              money(p.Exterior_Door_Price),
          );
        case "roof":
          if (lv === "none") return;
          if (lv === "heavy")
            return add(
              area,
              "Roof replacement",
              g.roofSqFt * p.Roof_Replace_Per_SqFt,
              "~" + round(g.roofSqFt) + " sq ft of roof at $" + p.Roof_Replace_Per_SqFt + "/sq ft",
            );
          return add(area, "Roof repair", p.Roof_Repair[lv], lv + " repair");
        case "exterior":
          if (lv === "none") return;
          if (lv === "light") return add(area, area.label, p.Exterior_Touchup, "touch-up and caulk");
          if (lv === "medium")
            return add(
              area,
              "Exterior paint",
              g.wallSqFt * p.Exterior_Paint_Per_WallSqFt,
              "~" + round(g.wallSqFt) + " sq ft of wall at $" + p.Exterior_Paint_Per_WallSqFt + "/sq ft",
            );
          return add(
            area,
            "New siding",
            g.wallSqFt * p.Siding_Per_WallSqFt,
            "~" + round(g.wallSqFt) + " sq ft of wall at $" + p.Siding_Per_WallSqFt + "/sq ft",
          );
        case "electrical":
          if (lv === "none") return;
          if (lv === "heavy")
            return add(
              area,
              "Rewire",
              sqft * p.Rewire_Per_SqFt,
              round(sqft) + " sq ft at $" + p.Rewire_Per_SqFt + "/sq ft",
            );
          return add(
            area,
            area.label,
            p.Electrical[lv],
            lv === "medium" ? "panel upgrade + repairs" : "repairs, outlets, fixtures",
          );
        case "plumbing":
          if (lv === "none") return;
          if (lv === "heavy")
            return add(
              area,
              "Repipe",
              sqft * p.Repipe_Per_SqFt,
              round(sqft) + " sq ft at $" + p.Repipe_Per_SqFt + "/sq ft",
            );
          return add(
            area,
            area.label,
            p.Plumbing[lv],
            lv === "medium" ? "partial repipe / drain work" : "leaks and fixtures",
          );
        case "hvac":
          if (lv === "none") return;
          return add(
            area,
            area.label,
            p.Hvac[lv] * (sqft > 2200 && lv === "heavy" ? 1.3 : 1),
            { light: "service/tune-up", medium: "furnace or A/C replaced", heavy: "full system" }[lv],
          );
        case "kitchen":
          if (lv === "none") return;
          return add(area, area.label, p.Kitchen[lv] * (sqft > 2200 ? 1.2 : 1), lv);
        default: {
          var table =
            p[
              area.key.charAt(0).toUpperCase() +
                area.key.slice(1).replace(/[A-Z]/g, function (c) {
                  return "_" + c;
                })
            ];
          if (lv === "none" || !table || !table[lv]) return;
          return add(area, area.label, table[lv], lv);
        }
      }
    });

    var subtotal = lines.reduce(function (s, l) {
      return s + l.cost;
    }, 0);
    var permits = round(subtotal * options.permitsPct);
    var contingency = round(subtotal * options.contingencyPct);
    var total = subtotal + permits + contingency;

    var year = Number(house.yearBuilt);
    if (year && year < 1978) notes.push("Built before 1978: assume lead paint; budget for safe prep.");
    if (year && year < 1960 && level(areas.electrical) === "none")
      notes.push("Built before 1960: check for old wiring (knob-and-tube, small panel).");
    if (year && year < 1950 && level(areas.plumbing) === "none")
      notes.push("Built before 1950: check for galvanized or cast-iron plumbing.");

    var sections = [];
    lines.forEach(function (l) {
      var s = sections.filter(function (x) {
        return x.name === l.section;
      })[0];
      if (!s) sections.push((s = { name: l.section, subtotal: 0 }));
      s.subtotal += l.cost;
    });

    return {
      lines: lines,
      sections: sections,
      subtotal: subtotal,
      permits: permits,
      contingency: contingency,
      total: total,
      // A real rehab usually lands within this band of the estimate.
      low: round(total * 0.85),
      high: round(total * 1.2),
      perSqFt: round(total / sqft),
      notes: notes,
    };
  }

  // A quick label for a total, like the deal finder's condition buckets.
  function rehabClass(total, sqft) {
    var per = total / num(sqft, 1200);
    if (per < 8) return "rental_ready";
    if (per < 22) return "light_rehab";
    if (per < 45) return "medium_rehab";
    return "heavy_rehab";
  }

  return {
    LEVELS: LEVELS,
    AREAS: AREAS,
    DEFAULT_HOME_PRICES: DEFAULT_HOME_PRICES,
    computeHomeEstimate: computeHomeEstimate,
    rehabClass: rehabClass,
  };
});
