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
import { z } from "zod";
import type { Listing } from "./sources/types.ts";

export interface PhotoConfig {
  model: string;
  maxPhotosPerHouse: number;
  maxHousesPerRun: number;
}

export const Condition = z.object({
  condition: z.enum(["rental_ready", "light_rehab", "medium_rehab", "heavy_rehab"]),
  rehab_estimate: z.number().describe("Total repair cost in US dollars to make it rent-ready / resale-ready"),
  confidence: z.enum(["low", "medium", "high"]),
  notes: z.string().describe("One or two plain sentences on what in the photos drove the rating"),
  rooms_seen: z.array(z.string()).describe("Which rooms or areas the photos actually show"),
});
export type ConditionRating = z.infer<typeof Condition> & { photos: number; ratedAt: string };

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
  return `${folder}#${h.digest("hex").slice(0, 12)}`;
}

const SYSTEM = `You are an experienced residential rehab estimator helping a real estate wholesaler.
You look at listing photos of a house and judge what it needs before an investor could rent it out or resell it.

Ratings:
- rental_ready: already renovated or well kept; at most paint, cleaning, small fixes (under ~$5/sqft).
- light_rehab: cosmetic work: paint, flooring, fixtures, minor kitchen/bath refresh (~$10-20/sqft).
- medium_rehab: kitchen and/or bath remodel, flooring throughout, some systems (~$25-40/sqft).
- heavy_rehab: gut job, major systems, roof, structural, water/fire damage, or uninhabitable (~$50+/sqft).

Estimate the total rehab cost in dollars for this house's size and a Midwest-style labor market unless told otherwise.
Judge only from what the photos show. If the photos skip key rooms (kitchen, bathrooms) or are only exterior shots,
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
  content.push({ type: "text", text: `${facts}\n\nRate this house's condition and estimate the rehab cost.` });

  const response = await client.messages.parse({
    model: cfg.model,
    max_tokens: 4000,
    system: SYSTEM,
    messages: [{ role: "user", content }],
    output_config: { format: zodOutputFormat(Condition) },
  });
  if (response.stop_reason === "refusal" || !response.parsed_output) return null;
  return { ...response.parsed_output, photos: files.length, ratedAt: new Date().toISOString().slice(0, 10) };
}

export function conditionLabel(c: ConditionRating["condition"]): string {
  return { rental_ready: "Rental-ready", light_rehab: "Light rehab", medium_rehab: "Medium rehab", heavy_rehab: "Heavy rehab" }[c];
}
