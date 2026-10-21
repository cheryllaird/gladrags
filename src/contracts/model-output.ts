import { z } from "zod";
import { singleLineText } from "./common";
import { ItemTagsSchema, type Category } from "./item";
import {
  OUTFIT_COUNT,
  OUTFIT_NAME_MAX_LENGTH,
  OUTFIT_REASON_MAX_LENGTH,
  OutfitItemIdsSchema,
  checkComposition,
} from "./outfit";

/**
 * Schemas for what the AI model returns. Model output is never trusted: the
 * caller parses it with one of these, retries once on failure, then falls
 * back as the spec says (empty tags for tagging; an error for ranking).
 *
 * Extra keys the model adds are stripped, not rejected. Wrong types, values
 * outside the vocabularies and missing fields are rejected.
 */

/** Tagging (vision): one item's tags, exactly the item tag schema. */
export const TaggingModelOutputSchema = ItemTagsSchema;
export type TaggingModelOutput = z.infer<typeof TaggingModelOutputSchema>;

/** Most outfits the first ranking pass may shortlist ("about 8"). */
export const SHORTLIST_MAX = 10;

/** Ranking pass 1 (tags only): a shortlist of outfits by item ID. */
export const RankingShortlistOutputSchema = z.object({
  outfits: z.array(z.object({ itemIds: OutfitItemIdsSchema })).min(1).max(SHORTLIST_MAX),
});
export type RankingShortlistOutput = z.infer<typeof RankingShortlistOutputSchema>;

/** Ranking pass 2 (thumbnails): the best N, each named and explained. */
export const RankingFinalOutputSchema = z.object({
  outfits: z
    .array(
      z.object({
        itemIds: OutfitItemIdsSchema,
        name: singleLineText(OUTFIT_NAME_MAX_LENGTH),
        reason: singleLineText(OUTFIT_REASON_MAX_LENGTH),
      }),
    )
    .min(1)
    .max(OUTFIT_COUNT.max),
});
export type RankingFinalOutput = z.infer<typeof RankingFinalOutputSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export type ModelParseResult<T> = { success: true; data: T } | { success: false; error: string };

/**
 * Parse raw model output (a JSON string, or an already-parsed value) against
 * a schema. Tolerates a ```json code fence around the JSON. Never throws.
 */
export function parseModelOutput<T>(schema: z.ZodType<T>, raw: unknown): ModelParseResult<T> {
  let value: unknown = raw;
  if (typeof raw === "string") {
    const text = raw
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "");
    try {
      value = JSON.parse(text);
    } catch {
      return { success: false, error: "Model output is not valid JSON" };
    }
  }
  const result = schema.safeParse(value);
  if (result.success) return { success: true, data: result.data };
  return { success: false, error: z.prettifyError(result.error) };
}

export interface RankedOutfitCheck<T extends { itemIds: string[] }> {
  valid: T[];
  rejected: { outfit: T; problem: string }[];
}

export interface CheckRankedOutfitsOptions {
  /** When the request has an anchor item, every outfit must include it. */
  anchorItemId?: string;
}

/**
 * Spec pipeline step 4: split ranked outfits into valid ones and ones with an
 * unknown item ID, a broken composition rule, or a missing anchor item.
 * `known` maps every item ID the model was allowed to use to its category.
 */
export function checkRankedOutfits<T extends { itemIds: string[] }>(
  outfits: readonly T[],
  known: ReadonlyMap<string, Category>,
  { anchorItemId }: CheckRankedOutfitsOptions = {},
): RankedOutfitCheck<T> {
  const result: RankedOutfitCheck<T> = { valid: [], rejected: [] };
  for (const outfit of outfits) {
    const unknown = outfit.itemIds.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      result.rejected.push({ outfit, problem: `Unknown item ID(s): ${unknown.join(", ")}` });
      continue;
    }
    if (anchorItemId && !outfit.itemIds.includes(anchorItemId)) {
      result.rejected.push({ outfit, problem: `Doesn't include the anchor item ${anchorItemId}` });
      continue;
    }
    const composition = checkComposition(outfit.itemIds.map((id) => known.get(id)!));
    if (!composition.ok) {
      result.rejected.push({ outfit, problem: composition.problem });
      continue;
    }
    result.valid.push(outfit);
  }
  return result;
}
