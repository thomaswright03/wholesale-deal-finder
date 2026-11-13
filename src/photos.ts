// Rate a house's condition from its listing photos with Claude.
//
// Photos go in photos/<folder>/ (committed to the repo) where <folder> is photoFolderName(listing).
// Any jpg/png/webp/gif files there are used (up to maxPhotosPerHouse, sorted by name).
// Ratings are cached in data/ratings.json, keyed by the folder and its photo list,
// so the same photos are never paid for twice.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { createRequire } from "node:module";
import { z } from "zod";
import type { Listing } from "./sources/types.ts";

// Whole-home rehab pricing from Home Restoration AI (vendor/home-restoration, copied from
// ~/repos/Home-Restoration-AI). Claude rates each area; this prices it.
const HomePricing = createRequire(import.meta.url)("../vendor/home-restoration/home-pricing.js");
export const AREA_KEYS: string[] = HomePricing.AREAS.map((a: any) => a.key);
const LEVEL = z.enum(["none", "light", "medium", "heavy"]);

export interface PhotoConfig {
  model: string;
  maxPhotosPerHouse: number;
  maxHousesPerRun: number;
}

export const Condition = z.object({
  condition: z.enum(["rental_ready", "light_rehab", "medium_rehab", "heavy_rehab"]),
  areas: z.object(Object.fromEntries(AREA_KEYS.map((k) => [k, LEVEL])) as Record<string, typeof LEVEL>)
    .describe("Work each area needs: none, light (cosmetic), medium (partial replacement), heavy (full replacement/gut)"),
  confidence: z.enum(["low", "medium", "high"]),
  notes: z.string().describe("One or two plain sentences on what in the photos drove the rating"),
  rooms_seen: z.array(z.string()).describe("Which rooms or areas the photos actually show"),
});
export type ConditionRating = z.infer<typeof Condition> & {
  photos: number;
  ratedAt: string;
  rehab_estimate: number; // whole-home total from Home Restoration AI pricing
  rehab_low?: number;
  rehab_high?: number;
  rehab_lines?: { label: string; cost: number; detail?: string }[];
};

const MEDIA: Record<string, "image/jpeg" | "image/png" | "image/webp" | "image/gif"> = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif",
};
const MAX_BYTES = 5 * 1024 * 1024; // API limit per image

export function photoFolderName(l: Listing): string {
  return `${l.address} ${l.city} ${l.state} ${l.zip}`.trim().replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function listPhotos(dir: string, max: number): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => MEDIA[extname(f).toLowerCase()] && statSync(join(dir, f)).size <= MAX_BYTES)
    .sort()
    .slice(0, max)
    .map((f) => join(dir, f));
}

export function photoSetKey(folder: string, files: string[]): string {
  const h = createHash("sha1");
  for (const f of files) h.update(basename(f) + ":" + statSync(f).size + ";");
  return `${folder}#v2#${h.digest("hex").slice(0, 12)}`;
}

const SYSTEM = `You are an experienced residential rehab estimator helping a real estate wholesaler.
You look at listing photos of a house and judge what it needs before an investor could rent it out or resell it.

For each area, pick the level of work it needs:
- none: fine as is
- light: cosmetic (paint, hardware, minor repairs, cleaning)
- medium: partial replacement (new counters or some cabinets, some flooring, panel upgrade, repairs)
- heavy: full replacement or gut (new kitchen, new roof, full repipe/rewire, new siding)

Areas: cleanout (trash-out), kitchen, appliances, bathrooms, flooring, interiorPaint, drywall, interiorDoors (and trim),
windows, exteriorDoors, roof, exterior (siding/paint), landscaping, hvac, waterHeater, electrical, plumbing, foundation.

Judge each area from what the photos show. For areas the photos don't show (often roof, HVAC, water heater, electrical,
plumbing, foundation), infer from the house's age and overall condition: a renovated house usually needs none there,
a neglected or very old one usually needs light to medium. Say in notes which areas you inferred.
Also give the overall condition: rental_ready, light_rehab, medium_rehab or heavy_rehab.
If the photos skip key rooms (kitchen, bathrooms) or are only exterior shots, or seem to show a different house,
say so in notes and use low confidence. Heavily staged or wide-angle photos can hide problems; note it if you suspect that.`;

export async function rateHouse(client: Anthropic, l: Listing, files: string[], cfg: PhotoConfig): Promise<ConditionRating | null> {
  const facts = [
    `Address: ${l.address}, ${l.city}, ${l.state} ${l.zip}`,
    `Type: ${l.propertyType}`,
    l.beds != null ? `Beds: ${l.beds}` : "",
    l.baths != null ? `Baths: ${l.baths}` : "",
    l.sqft != null ? `Square feet: ${l.sqft}` : "",
    l.yearBuilt != null ? `Year built: ${l.yearBuilt}` : "",
    `List price: $${l.price.toLocaleString("en-US")}`,
  ].filter(Boolean).join("\n");

  const content: Anthropic.ContentBlockParam[] = [];
  files.forEach((f, i) => {
    content.push({ type: "text", text: `Photo ${i + 1}:` });
    content.push({
      type: "image",
      source: { type: "base64", media_type: MEDIA[extname(f).toLowerCase()], data: readFileSync(f).toString("base64") },
    });
  });
  content.push({ type: "text", text: `${facts}\n\nRate the work each area of this house needs.` });

  const response = await client.messages.parse({
    model: cfg.model,
    max_tokens: 4000,
    system: SYSTEM,
    messages: [{ role: "user", content }],
    output_config: { format: zodOutputFormat(Condition) },
  });
  if (response.stop_reason === "refusal" || !response.parsed_output) return null;
  const out = response.parsed_output;
  const est = priceHome(l, out.areas);
  return {
    ...out,
    rehab_estimate: est.total,
    rehab_low: est.low,
    rehab_high: est.high,
    rehab_lines: est.lines.map((x: any) => ({ label: x.label, cost: x.cost, detail: x.detail })),
    photos: files.length,
    ratedAt: new Date().toISOString().slice(0, 10),
  };
}

// Price the house with Home Restoration AI's whole-home model from Claude's per-area levels.
export function priceHome(l: Listing, areas: Record<string, string>, prices?: object, regionFactor = 1) {
  return HomePricing.computeHomeEstimate(
    { sqft: l.sqft, beds: l.beds, baths: l.baths, yearBuilt: l.yearBuilt, areas },
    { prices, regionFactor },
  );
}

export function conditionLabel(c: ConditionRating["condition"]): string {
  return { rental_ready: "Rental-ready", light_rehab: "Light rehab", medium_rehab: "Medium rehab", heavy_rehab: "Heavy rehab" }[c];
}
