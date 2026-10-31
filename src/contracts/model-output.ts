import { z } from "zod";
import { emptyToNull, scrapedText, singleLineText } from "./common";
import { CategorySchema, ItemTagsSchema, SourceUrlSchema, type Category } from "./item";
import {
  GapDescriptionsSchema,
  MAX_SHOP_ITEM_GAPS,
  OUTFIT_COUNT,
  OUTFIT_NAME_MAX_LENGTH,
  OUTFIT_REASON_MAX_LENGTH,
  OutfitItemIdsSchema,
  checkComposition,
  missingCategoriesForOutfits,
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

/**
 * Gaps in a ranked outfit: slots the model fills with a described item it
 * would add (category, optional subcategory, colours from the palette, one
 * line of description). Missing means none, so replies from before gaps
 * still parse.
 */
const RankedGapsSchema = GapDescriptionsSchema.optional();

/** Ranking pass 1 (tags only): a shortlist of outfits by item ID, plus any gaps. */
export const RankingShortlistOutputSchema = z.object({
  outfits: z.array(z.object({ itemIds: OutfitItemIdsSchema, gaps: RankedGapsSchema })).min(1).max(SHORTLIST_MAX),
});
export type RankingShortlistOutput = z.infer<typeof RankingShortlistOutputSchema>;

/** Ranking pass 2 (thumbnails): the best N, each named and explained, plus any gaps. */
export const RankingFinalOutputSchema = z.object({
  outfits: z
    .array(
      z.object({
        itemIds: OutfitItemIdsSchema,
        gaps: RankedGapsSchema,
        name: singleLineText(OUTFIT_NAME_MAX_LENGTH),
        reason: singleLineText(OUTFIT_REASON_MAX_LENGTH),
      }),
    )
    .min(1)
    .max(OUTFIT_COUNT.max),
});
export type RankingFinalOutput = z.infer<typeof RankingFinalOutputSchema>;

// ---------------------------------------------------------------------------
// Shop search (Gemini with Google Search grounding)
// ---------------------------------------------------------------------------

/** Most candidate links the model may give per gap; the server checks them and keeps up to three. */
export const SHOP_SEARCH_CANDIDATES_MAX = 8;

/**
 * One candidate product page from the grounded search. Not trusted: the
 * server keeps a link only if it's on one of the user's chosen shops
 * (shopForUrl), then fetches it through the add-by-link fetcher to confirm
 * it exists and to read the real title, price and image.
 *
 * A candidate whose link isn't a valid http(s) URL is dropped rather than
 * failing the whole reply (see ShopSearchModelOutputSchema).
 */
export const ShopSearchCandidateSchema = z.object({
  url: SourceUrlSchema,
  /** The model's title for the page; display uses the page's own title. */
  title: scrapedText(200),
});
export type ShopSearchCandidate = z.infer<typeof ShopSearchCandidateSchema>;

/** Keeps the candidates that parse, drops the rest, then caps the count. */
const candidateList = z
  .array(z.unknown())
  .transform((values) =>
    values
      .map((value) => ShopSearchCandidateSchema.safeParse(value))
      .filter((r) => r.success)
      .map((r) => r.data)
      .slice(0, SHOP_SEARCH_CANDIDATES_MAX),
  );

/**
 * The grounded search's reply: candidate product pages per gap, keyed by
 * the gap's category (one gap per category in an outfit). A gap with no
 * candidates is fine ("nothing found").
 */
export const ShopSearchModelOutputSchema = z.object({
  gaps: z
    .array(z.object({ category: CategorySchema, candidates: candidateList }))
    .refine((gaps) => new Set(gaps.map((g) => g.category)).size === gaps.length, { error: "One entry per gap" }),
});
export type ShopSearchModelOutput = z.infer<typeof ShopSearchModelOutputSchema>;

// ---------------------------------------------------------------------------
// Order email extraction
// ---------------------------------------------------------------------------

export const EMAIL_LINE_ITEM_LIMITS = { name: 200, brand: 80, colour: 60, size: 30 } as const;

/** Most clothing and shoe lines read from one email; any more are ignored. */
export const MAX_EMAIL_LINE_ITEMS = 20;

/** An optional link from the model: an invalid one reads as null rather than failing the reply. */
const optionalModelUrl = z.preprocess((value) => {
  const v = emptyToNull(value);
  return SourceUrlSchema.safeParse(v).success ? v : null;
}, SourceUrlSchema.nullable());

/**
 * One clothing or shoe line from an order confirmation email. Free text
 * (brand, colour, size) is cleaned like scraped page text: single line,
 * length-limited, blank reads as null. Bags, homeware and gift cards
 * should already be left out by the model; the server tags each item from
 * its image afterwards, which decides the real category.
 */
export const EmailLineItemSchema = z.object({
  name: scrapedText(EMAIL_LINE_ITEM_LIMITS.name).pipe(z.string()),
  brand: scrapedText(EMAIL_LINE_ITEM_LIMITS.brand),
  /** As the email says it ("Khaki"), not the palette: tagging maps it. */
  colour: scrapedText(EMAIL_LINE_ITEM_LIMITS.colour),
  size: scrapedText(EMAIL_LINE_ITEM_LIMITS.size),
  /** The product page, if the email links to one. */
  productUrl: optionalModelUrl,
  /** The product image in the email, if any. */
  imageUrl: optionalModelUrl,
});
export type EmailLineItem = z.infer<typeof EmailLineItemSchema>;

/** A calendar date, YYYY-MM-DD. */
export const CalendarDateSchema = z.iso.date();

/**
 * What the model reads from a forwarded order email. `items` may be empty
 * (no clothes or shoes in the order). A line that doesn't parse (no name,
 * say) is dropped, like a bad shop search candidate, so one bad line never
 * fails the email; then the first MAX_EMAIL_LINE_ITEMS good lines are kept.
 * An unreadable shop name or order date reads as null.
 */
export const OrderEmailModelOutputSchema = z.object({
  shopName: scrapedText(80),
  orderDate: z.preprocess((value) => {
    const v = emptyToNull(value);
    return CalendarDateSchema.safeParse(v).success ? v : null;
  }, CalendarDateSchema.nullable()),
  items: z.array(z.unknown()).transform((values) =>
    values
      .map((value) => EmailLineItemSchema.safeParse(value))
      .filter((r) => r.success)
      .map((r) => r.data)
      .slice(0, MAX_EMAIL_LINE_ITEMS),
  ),
});
export type OrderEmailModelOutput = z.infer<typeof OrderEmailModelOutputSchema>;

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

/**
 * How gaps are judged (orchestrator decision A: gaps are about slots, not
 * categories). Each gap is one of two kinds:
 *
 * - A **required-slot gap**: a slot the outfit's structure needs (top and
 *   bottom, or a dress or jumpsuit, plus shoes) that the wardrobe can't
 *   fill, i.e. its category is in missingCategoriesForOutfits(
 *   fillableCategories, structure), where the structure is the outfit's own
 *   owned top, bottom or dress (else the anchor's category). So an owned
 *   top with a bottom gap is allowed when the wardrobe has no bottoms, even
 *   if it has a dress (orchestrator, 2026-10-31). When the wardrobe has no separates
 *   and no dress (both top and bottom missing), a single dress gap may stand
 *   in for them. Always allowed.
 * - Any other gap is a **shop-item gap**: a slot the wardrobe could fill,
 *   and every outerwear gap (outerwear is optional, so never required).
 *   Allowed only with includeShopItems, and at most MAX_SHOP_ITEM_GAPS per
 *   outfit.
 *
 * Example refused: a wardrobe with tops, bottoms and shoes, an outfit of
 * owned shoes plus a dress gap, shop items off (the separates fill the body).
 */
export interface GapRules {
  /** Categories the (filtered) wardrobe has items in for this request. */
  fillableCategories: ReadonlySet<Category>;
  /** The request's includeShopItems. */
  includeShopItems: boolean;
}

/** Whether a gap in `category` is a required-slot gap (see GapRules). */
export function isRequiredSlotGap(category: Category, missing: ReadonlySet<Category>): boolean {
  if (category === "outerwear") return false;
  if (missing.has(category)) return true;
  return category === "dress_jumpsuit" && missing.has("top") && missing.has("bottom");
}

export interface CheckRankedOutfitsOptions {
  /** When the request has an anchor item, every outfit must include it (as an owned item). */
  anchorItemId?: string;
  /**
   * How gaps are judged. Leave it out and any gap is rejected, so callers
   * that don't handle gaps yet can't let one through.
   */
  gaps?: GapRules;
}

/**
 * Spec pipeline step 4: split ranked outfits into valid ones and ones with an
 * unknown item ID, a missing anchor item, a broken composition rule (owned
 * items and gaps together, at least one owned item), or a gap that isn't
 * allowed (see GapRules: a shop-item gap without includeShopItems, or more
 * than MAX_SHOP_ITEM_GAPS of them). `known` maps every item ID the model was
 * allowed to use to its category.
 */
export function checkRankedOutfits<T extends { itemIds: string[]; gaps?: readonly { category: Category }[] }>(
  outfits: readonly T[],
  known: ReadonlyMap<string, Category>,
  { anchorItemId, gaps: gapRules }: CheckRankedOutfitsOptions = {},
): RankedOutfitCheck<T> {
  const result: RankedOutfitCheck<T> = { valid: [], rejected: [] };
  for (const outfit of outfits) {
    const gapCategories = (outfit.gaps ?? []).map((g) => g.category);
    const unknown = outfit.itemIds.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      result.rejected.push({ outfit, problem: `Unknown item ID(s): ${unknown.join(", ")}` });
      continue;
    }
    if (anchorItemId && !outfit.itemIds.includes(anchorItemId)) {
      result.rejected.push({ outfit, problem: `Doesn't include the anchor item ${anchorItemId}` });
      continue;
    }
    if (gapCategories.length > 0 && !gapRules) {
      result.rejected.push({ outfit, problem: "Gaps aren't allowed here" });
      continue;
    }
    const composition = checkComposition(
      outfit.itemIds.map((id) => known.get(id)!),
      gapCategories,
    );
    if (!composition.ok) {
      result.rejected.push({ outfit, problem: composition.problem });
      continue;
    }
    if (gapRules) {
      const anchorCategory = anchorItemId ? known.get(anchorItemId) : undefined;
      const ownedBody = outfit.itemIds
        .map((id) => known.get(id)!)
        .find((c) => c === "top" || c === "bottom" || c === "dress_jumpsuit");
      const missing = new Set(missingCategoriesForOutfits(gapRules.fillableCategories, ownedBody ?? anchorCategory));
      const shopGaps = gapCategories.filter((c) => !isRequiredSlotGap(c, missing));
      const allowed = gapRules.includeShopItems ? MAX_SHOP_ITEM_GAPS : 0;
      if (shopGaps.length > allowed) {
        result.rejected.push({
          outfit,
          problem: gapRules.includeShopItems
            ? `At most ${MAX_SHOP_ITEM_GAPS} shop-item gap (${shopGaps.join(", ")})`
            : `Shop-item gap(s) not allowed without "Include items from my shops": ${shopGaps.join(", ")}`,
        });
        continue;
      }
    }
    result.valid.push(outfit);
  }
  return result;
}
