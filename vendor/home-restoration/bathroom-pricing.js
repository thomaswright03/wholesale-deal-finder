// Room Designer 3D — shared bathroom pricing model.
//
// The single source of truth for bathroom labor prices AND for the
// calculation itself. The design studio's estimate (js/studio.js) calls
// computeEstimate() below with includeTrade: true and the business's own
// prices (js/business.js replaces DEFAULT_PRICES with what the owner set on
// the account page): every line, including the per-fixture plumbing points,
// the wiring and any drain line the layout needs, is at a rate the business
// can see and change. Everything exported here has a caller in a page; the
// unit tests cover the same path the studio runs.
//
// Only the work that is explicitly chosen is priced: nothing is assumed
// from the room's dimensions alone. The line items are exactly the charges
// the business owner gave — do not add any without new pricing from the owner.
//
// Labor only. Materials, permits, and profit margin are never included.
//
// Text is in the page's language (js/i18n.js); labels below are read
// through getters so they always follow it.
//
// Loads as a plain browser script (window.BathroomPricing) and as a Node
// module (for the unit tests).

(function (/** @type {any} */ root, factory) {
  "use strict";
  var api = factory(root.I18n || (typeof require === "function" ? require("./i18n.js") : null));
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.BathroomPricing = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (I18n) {
  "use strict";

  var T = I18n.t;

  // obj[prop] reads the translation of `key` in the page's language.
  function translated(obj, prop, key) {
    Object.defineProperty(obj, prop, {
      enumerable: true,
      get: function () {
        return T(key);
      },
    });
    return obj;
  }

  var DEFAULT_PRICES = {
    Demo_Price_Per_SqFt: 37.5,

    Toilet_Price: 200,
    Sink_Price: 200,
    Shower_Price: 500,
    Shower_Door_Price: 300,
    Door_Price: 200,
    Vanity_Price: 150,
    Cabinet_Price: 60,
    Mirror_Price: 100,
    Mirror_Huge_Price: 300,
    Shower_Shelf_Price: 125,
    // A business's own bathtub install price. Empty (null) means 70% of its
    // shower price, the rule the first client priced by (bathtubPrice()).
    Bathtub_Price: null,

    Tile_Price_Per_SqFt: 4,
    // Owner-confirmed: $5 per sq ft of bathroom floor.
    Floor_Price_Per_SqFt: 5,
    Painting_Price_Per_SqFt: 1.79,

    Plumbing_Price_Per_Point: 300,
    No_Stack_Surcharge_Price: 1000,
    Bad_Valve_Surcharge_Price: 400,

    Electrical_Price_Per_Point: 100,
    // Running a new drain line to a fixture away from the stack wall:
    // opening the floor, the pipe, the fall and patching after.
    Drain_Run_Price_Per_Ft: 95,
  };

  // The bathtub install price: the business's own Bathtub_Price when set,
  // else 30% less than its shower price (the first client's rule).
  function bathtubPrice(prices) {
    var own = prices.Bathtub_Price;
    if (own !== undefined && own !== null && own !== "" && isFinite(Number(own)) && Number(own) >= 0) {
      return roundCents(Number(own));
    }
    return roundCents((Number(prices.Shower_Price) || 0) * 0.7);
  }

  // Fixture counts, in the order they are asked for and listed.
  // needsPlumbing: installing it also needs plumbing work, priced per point
  // (one point per fixture) at the business's Plumbing_Price_Per_Point.
  var FIXTURES = [
    { key: "Toilet_Quantity", priceKey: "Toilet_Price", needsPlumbing: true },
    { key: "Sink_Quantity", priceKey: "Sink_Price", needsPlumbing: true },
    { key: "Bathtub_Quantity", derivedPrice: bathtubPrice, needsPlumbing: true },
    { key: "Shower_Quantity", priceKey: "Shower_Price", needsPlumbing: true },
    { key: "Shower_Door_Quantity", priceKey: "Shower_Door_Price" },
    { key: "Door_Quantity", priceKey: "Door_Price" },
    // A vanity carries its own sink, so its plumbing counts too.
    { key: "Vanity_Quantity", priceKey: "Vanity_Price", needsPlumbing: true },
    { key: "Cabinet_Quantity", priceKey: "Cabinet_Price" },
    { key: "Mirror_Quantity", priceKey: "Mirror_Price" },
    { key: "Mirror_Huge_Quantity", priceKey: "Mirror_Huge_Price" },
    { key: "Shower_Shelf_Quantity", priceKey: "Shower_Shelf_Price" },
  ];
  // label: "Toilet", plural: "Toilets" (and their translations).
  FIXTURES.forEach(function (f) {
    translated(f, "label", "fixture." + f.key);
    translated(f, "plural", "fixtures." + f.key);
  });

  // The owner's price (DEFAULT_PRICES key) behind each estimate line, by the
  // line's key. A bathtub is at the owner's bathtub price, or 70% of their
  // shower price (bathtubPrice()), so either one set makes it theirs.
  var LINE_PRICE_KEYS = {
    demolition: ["Demo_Price_Per_SqFt"],
    floorTile: ["Tile_Price_Per_SqFt"],
    flooring: ["Floor_Price_Per_SqFt"],
    wallTile: ["Tile_Price_Per_SqFt"],
    wallPaint: ["Painting_Price_Per_SqFt"],
    ceilingPaint: ["Painting_Price_Per_SqFt"],
    drainRun: ["Drain_Run_Price_Per_Ft"],
    electrical: ["Electrical_Price_Per_Point"],
    plumbing: ["Plumbing_Price_Per_Point"],
    noStack: ["No_Stack_Surcharge_Price"],
    badValve: ["Bad_Valve_Surcharge_Price"],
  };
  FIXTURES.forEach(function (f) {
    LINE_PRICE_KEYS[f.key] = f.priceKey ? [f.priceKey] : ["Bathtub_Price", "Shower_Price"];
  });

  // The DEFAULT_PRICES keys an estimate line's rate comes from ([] for a
  // line this module doesn't know).
  function linePriceKeys(lineKey) {
    return LINE_PRICE_KEYS[lineKey] || [];
  }

  function option(value, key) {
    return translated({ value: value }, "label", key);
  }

  var YES_NO = [option(true, "choice.yes"), option(false, "choice.no")];

  // The work questions (the studio's Finishes step). An estimate needs every
  // one answered.
  var SCOPE_QUESTIONS = [
    { key: "demolition", options: YES_NO },
    {
      key: "floorFinish",
      options: [
        option("tile", "choice.floor.tile"),
        option("flooring", "choice.floor.flooring"),
        option("none", "choice.none"),
      ],
    },
    {
      // One choice per wall surface, so the same walls can never be charged
      // for both tile and paint.
      key: "walls",
      options: [
        option("tile", "choice.walls.tile"),
        option("tileWet", "choice.walls.tileWet"),
        option("paint", "choice.walls.paint"),
        option("none", "choice.neither"),
      ],
    },
    { key: "paintCeiling", options: YES_NO },
  ];
  SCOPE_QUESTIONS.forEach(function (q) {
    translated(q, "label", "question." + q.key);
  });

  // A drain run longer than this is a bad input, not a bathroom.
  var MAX_DRAIN_RUN_FT = 200;

  function roundCents(n) {
    return Math.round((Number(n) || 0) * 100) / 100;
  }

  // US dollars, written the way the page's language writes numbers
  // ($1,234.50 in English and Spanish, US$ 1.234,50 in Portuguese).
  // locale: optional, e.g. "pt-BR"; default: the page's language.
  function money(value, locale) {
    var n = Number(value) || 0;
    return formatUsd(n, 2, locale || I18n.locale());
  }

  // Whole dollars when there are no cents ($60), otherwise cents ($1.79).
  function shortMoney(value, locale) {
    var n = Number(value) || 0;
    return n % 1 === 0 ? formatUsd(n, 0, locale || I18n.locale()) : money(n, locale);
  }

  function formatUsd(n, digits, locale) {
    var opts = { minimumFractionDigits: digits, maximumFractionDigits: digits };
    if (locale === "en-US") return (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString("en-US", opts);
    return n.toLocaleString(locale, Object.assign({ style: "currency", currency: "USD" }, opts));
  }

  function formatQty(n, locale) {
    return (Number(n) || 0).toLocaleString(locale || I18n.locale(), { maximumFractionDigits: 2 });
  }

  // Parses a form value. Returns null for blank, NaN for anything that
  // isn't a plain finite number.
  function parseNumber(value) {
    if (value === undefined || value === null) return null;
    if (typeof value === "number") return isFinite(value) ? value : NaN;
    var s = String(value).trim();
    if (s === "") return null;
    if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) return NaN;
    return Number(s);
  }

  function fixtureRate(fixture, prices) {
    return fixture.derivedPrice ? fixture.derivedPrice(prices) : Number(prices[fixture.priceKey]) || 0;
  }

  function plumbingFixtureCount(values) {
    return FIXTURES.reduce(function (sum, f) {
      return f.needsPlumbing ? sum + (parseNumber(values[f.key]) || 0) : sum;
    }, 0);
  }

  // Floor and wall areas. The design studio also passes the doorways'
  // area (Wall_Openings_SqFt, taken off the walls) and the tile around a
  // tub (Wet_Wall_SqFt, for walls: "tileWet").
  function areas(values) {
    var w = parseNumber(values.Bathroom_Width_Ft) || 0;
    var l = parseNumber(values.Bathroom_Length_Ft) || 0;
    var h = parseNumber(values.Bathroom_Height_Ft) || 0;
    var gross = 2 * h * (w + l);
    var openings = Math.min(Math.max(parseNumber(values.Wall_Openings_SqFt) || 0, 0), gross);
    var walls = gross - openings;
    var wet = Math.min(Math.max(parseNumber(values.Wet_Wall_SqFt) || 0, 0), walls);
    return {
      floorSqFt: roundCents(w * l),
      grossWallSqFt: roundCents(gross),
      openingsSqFt: roundCents(openings),
      wallSqFt: roundCents(walls),
      wetWallSqFt: roundCents(wet),
    };
  }

  // What the chosen work needs measured.
  function scopeNeeds(scope) {
    scope = scope || {};
    var walls = scope.walls === "tile" || scope.walls === "tileWet" || scope.walls === "paint";
    var floorArea =
      scope.demolition === true ||
      scope.floorFinish === "tile" ||
      scope.floorFinish === "flooring" ||
      scope.paintCeiling === true ||
      walls;
    return { floorArea: floorArea, height: walls };
  }

  // The one bathroom calculation. Prices only the work in `scope` and the
  // fixture counts in `values`.
  //
  // values: { Bathroom_Width_Ft, Bathroom_Length_Ft, Bathroom_Height_Ft,
  //           <fixture>_Quantity..., Electrical_Points, Drain_Run_Ft,
  //           and with includeTrade:
  //           No_Stack_Surcharge_Included, Bad_Valve_Surcharge_Included }
  // scope:  { demolition: bool, floorFinish: "tile"|"flooring"|"none",
  //           walls: "tile"|"tileWet"|"paint"|"none", paintCeiling: bool }
  //         ("tileWet": tile around the tub, Wet_Wall_SqFt, and paint the
  //         rest of the walls)
  // options: { prices (default DEFAULT_PRICES), includeTrade (default false) }
  //
  // Every line carries its quantity x rate. Lines costing $0 are left out.
  function computeEstimate(values, scope, options) {
    values = values || {};
    scope = scope || {};
    options = options || {};
    var prices = Object.assign({}, DEFAULT_PRICES, options.prices || {});
    var a = areas(values);
    var lines = [];

    function addLine(key, section, label, qty, unit, rate) {
      qty = Number(qty) || 0;
      rate = Number(rate) || 0;
      var cost = roundCents(qty * rate);
      if (cost <= 0) return;
      lines.push({
        key: key,
        section: section,
        label: label,
        qty: qty,
        unit: unit,
        rate: rate,
        cost: cost,
        detail: T("line.detail", { qty: formatQty(qty), unit: unit, rate: money(rate) }),
      });
    }

    function addFlat(key, section, label, rate) {
      rate = Number(rate) || 0;
      if (rate <= 0) return;
      lines.push({
        key: key,
        section: section,
        label: label,
        qty: 1,
        unit: T("unit.flat"),
        rate: rate,
        cost: roundCents(rate),
        detail: T("line.flatCharge"),
      });
    }

    if (scope.demolition === true) {
      addLine(
        "demolition",
        T("section.preparation"),
        T("line.demolition"),
        a.floorSqFt,
        T("unit.sqftFloor"),
        prices.Demo_Price_Per_SqFt,
      );
    }

    FIXTURES.forEach(function (f) {
      var qty = parseNumber(values[f.key]) || 0;
      addLine(
        f.key,
        T("section.fixtures"),
        f.plural,
        qty,
        T(qty === 1 ? "unit.unit" : "unit.units"),
        fixtureRate(f, prices),
      );
    });

    var surfaces = T("section.surfaces");
    var sqft = T("unit.sqft");
    if (scope.floorFinish === "tile") {
      addLine("floorTile", surfaces, T("line.floorTile"), a.floorSqFt, sqft, prices.Tile_Price_Per_SqFt);
    } else if (scope.floorFinish === "flooring") {
      addLine("flooring", surfaces, T("line.flooring"), a.floorSqFt, sqft, prices.Floor_Price_Per_SqFt);
    }
    if (scope.walls === "tile") {
      addLine("wallTile", surfaces, T("line.wallTile"), a.wallSqFt, sqft, prices.Tile_Price_Per_SqFt);
    } else if (scope.walls === "tileWet") {
      addLine("wallTile", surfaces, T("line.wallTileWet"), a.wetWallSqFt, sqft, prices.Tile_Price_Per_SqFt);
      addLine(
        "wallPaint",
        surfaces,
        T("line.wallPaint"),
        roundCents(a.wallSqFt - a.wetWallSqFt),
        sqft,
        prices.Painting_Price_Per_SqFt,
      );
    } else if (scope.walls === "paint") {
      addLine("wallPaint", surfaces, T("line.wallPaint"), a.wallSqFt, sqft, prices.Painting_Price_Per_SqFt);
    }
    if (scope.paintCeiling === true) {
      addLine("ceilingPaint", surfaces, T("line.ceilingPaint"), a.floorSqFt, sqft, prices.Painting_Price_Per_SqFt);
    }

    var drainFt = Math.max(0, Math.min(MAX_DRAIN_RUN_FT, parseNumber(values.Drain_Run_Ft) || 0));
    if (drainFt > 0) {
      addLine(
        "drainRun",
        T("section.plumbing"),
        T("line.drainRun"),
        drainFt,
        T(drainFt === 1 ? "unit.foot" : "unit.feet"),
        prices.Drain_Run_Price_Per_Ft,
      );
    }
    var elecPoints = parseNumber(values.Electrical_Points) || 0;
    if (elecPoints > 0) {
      addLine(
        "electrical",
        T("section.electrical"),
        T("line.electricalPoints"),
        elecPoints,
        T(elecPoints === 1 ? "unit.point" : "unit.points"),
        prices.Electrical_Price_Per_Point,
      );
    }
    var fixtureCount = plumbingFixtureCount(values);
    if (options.includeTrade) {
      var plumbing = T("section.plumbing");
      addLine(
        "plumbing",
        plumbing,
        T("line.plumbingPoints"),
        fixtureCount,
        T(fixtureCount === 1 ? "unit.point" : "unit.points"),
        prices.Plumbing_Price_Per_Point,
      );
      if (values.No_Stack_Surcharge_Included === true) {
        addFlat("noStack", plumbing, T("line.noStack"), prices.No_Stack_Surcharge_Price);
      }
      if (values.Bad_Valve_Surcharge_Included === true) {
        addFlat("badValve", plumbing, T("line.badValve"), prices.Bad_Valve_Surcharge_Price);
      }
    }

    var subtotal = roundCents(
      lines.reduce(function (sum, l) {
        return sum + l.cost;
      }, 0),
    );

    return {
      lines: lines,
      floorSqFt: a.floorSqFt,
      wallSqFt: a.wallSqFt,
      grossWallSqFt: a.grossWallSqFt,
      openingsSqFt: a.openingsSqFt,
      wetWallSqFt: scope.walls === "tileWet" ? a.wetWallSqFt : 0,
      plumbingFixtureCount: fixtureCount,
      // Whether the per-fixture plumbing is in the lines (includeTrade) or
      // left for a separate quote, so notes about it can say which.
      plumbingIncluded: !!options.includeTrade,
      // Labor only: no tax is added (the estimate says taxes aren't included).
      subtotal: subtotal,
      total: subtotal,
    };
  }

  function optionLabel(questionKey, value) {
    var q = SCOPE_QUESTIONS.filter(function (x) {
      return x.key === questionKey;
    })[0];
    var opt = q
      ? q.options.filter(function (o) {
          return o.value === value;
        })[0]
      : null;
    return opt ? opt.label : T("choice.notAnswered");
  }

  // One line describing the chosen work, e.g. "Demolition: No; new floor:
  // Other flooring; walls: Neither; paint ceiling: No".
  function describeScope(scope) {
    scope = scope || {};
    return T("scope.describe", {
      demolition: optionLabel("demolition", scope.demolition),
      floor: optionLabel("floorFinish", scope.floorFinish),
      walls: optionLabel("walls", scope.walls),
      ceiling: optionLabel("paintCeiling", scope.paintCeiling),
    });
  }

  // Plain-text list of what an estimate assumed (estimate card and PDFs).
  function estimateAssumptions(values, scope, result) {
    var needs = scopeNeeds(scope);
    var w = formatQty(parseNumber(values.Bathroom_Width_Ft) || 0);
    var l = formatQty(parseNumber(values.Bathroom_Length_Ft) || 0);
    var h = formatQty(parseNumber(values.Bathroom_Height_Ft) || 0);
    var list = [T("assume.scope", { scope: describeScope(scope) })];
    if (needs.floorArea) {
      list.push(T("assume.floorArea", { w: w, l: l, area: formatQty(result.floorSqFt) }));
    }
    if (needs.height) {
      if (result.openingsSqFt > 0) {
        list.push(
          T("assume.wallAreaDoors", {
            w: w,
            l: l,
            h: h,
            gross: formatQty(result.grossWallSqFt),
            doors: formatQty(result.openingsSqFt),
            area: formatQty(result.wallSqFt),
          }),
        );
      } else {
        list.push(T("assume.wallArea", { w: w, l: l, h: h, area: formatQty(result.wallSqFt) }));
      }
      if (scope.walls === "tileWet") list.push(T("assume.wetArea", { area: formatQty(result.wetWallSqFt) }));
    }
    list.push(T("assume.fixtures"));
    return list;
  }

  return {
    DEFAULT_PRICES: DEFAULT_PRICES,
    bathtubPrice: bathtubPrice,
    money: money,
    shortMoney: shortMoney,
    formatQty: formatQty,
    parseNumber: parseNumber,
    roundCents: roundCents,
    plumbingFixtureCount: plumbingFixtureCount,
    areas: areas,
    computeEstimate: computeEstimate,
    linePriceKeys: linePriceKeys,
    describeScope: describeScope,
    estimateAssumptions: estimateAssumptions,
  };
});
