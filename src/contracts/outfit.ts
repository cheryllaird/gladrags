import { z } from "zod";
import { IdSchema, TimestampSchema, singleLineText } from "./common";
import { CategorySchema, WardrobeItemSchema, type Category } from "./item";
import { StyleChoiceSchema } from "./styles";

export const OUTFIT_STATUSES = ["suggested", "saved", "liked", "rejected"] as const;
export const OutfitStatusSchema = z.enum(OUTFIT_STATUSES);
export type OutfitStatus = z.infer<typeof OutfitStatusSchema>;

export const OUTFIT_COUNT = { default: 4, min: 3, max: 5 } as const;
export const GUIDANCE_MAX_LENGTH = 200;
export const OUTFIT_NAME_MAX_LENGTH = 40;
export const OUTFIT_REASON_MAX_LENGTH = 160;

/** Smallest outfit is dress + shoes; largest is top + bottom + shoes + outerwear. */
export const OUTFIT_ITEM_COUNT = { min: 2, max: 4 } as const;

export const GuidanceSchema = singleLineText(GUIDANCE_MAX_LENGTH);

/** Body of POST /api/outfits. */
export const OutfitRequestSchema = z.object({
  style: StyleChoiceSchema,
  /** Build outfits around this item ("build an outfit around this"). */
  anchorItemId: IdSchema.optional(),
  /** Free text such as "no heels" or "use my green dress". */
  guidance: GuidanceSchema.optional(),
  count: z.int().min(OUTFIT_COUNT.min).max(OUTFIT_COUNT.max).default(OUTFIT_COUNT.default),
});
export type OutfitRequest = z.infer<typeof OutfitRequestSchema>;
/** What callers send: `count` may be left out. */
export type OutfitRequestInput = z.input<typeof OutfitRequestSchema>;

/** The request as stored on each outfit row (outfits.request jsonb). */
export const StoredOutfitRequestSchema = z.object({
  style: StyleChoiceSchema,
  guidance: GuidanceSchema.nullable(),
  anchorItemId: IdSchema.nullable(),
});
export type StoredOutfitRequest = z.infer<typeof StoredOutfitRequestSchema>;

export const OutfitItemIdsSchema = z
  .array(IdSchema)
  .min(OUTFIT_ITEM_COUNT.min)
  .max(OUTFIT_ITEM_COUNT.max)
  .refine((ids) => new Set(ids).size === ids.length, { error: "An item can't appear twice in one outfit" });

/** An outfit as the API returns it, with its items included for the collage. */
export const OutfitSchema = z.object({
  id: IdSchema,
  request: StoredOutfitRequestSchema,
  name: singleLineText(OUTFIT_NAME_MAX_LENGTH),
  reason: singleLineText(OUTFIT_REASON_MAX_LENGTH),
  itemIds: OutfitItemIdsSchema,
  /** Same items as itemIds, in the same order. */
  items: z.array(WardrobeItemSchema),
  status: OutfitStatusSchema,
  /** Set when this outfit came from refining another one. */
  parentOutfitId: IdSchema.nullable(),
  createdAt: TimestampSchema,
});
export type Outfit = z.infer<typeof OutfitSchema>;

/**
 * Response of POST /api/outfits and POST /api/outfits/[id]/refine.
 * `incomplete_wardrobe` is a normal outcome, not an error: the UI tells the
 * user which categories to add.
 */
export const OutfitGenerationResponseSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), outfits: z.array(OutfitSchema).min(1).max(OUTFIT_COUNT.max) }),
  z.object({
    status: z.literal("incomplete_wardrobe"),
    /**
     * `missing_category`: the wardrobe has no valid combination at all.
     * `nothing_fits`: combinations exist, but none suit this style or anchor.
     */
    reason: z.enum(["missing_category", "nothing_fits"]),
    /** Categories that would unlock outfits. Empty for `nothing_fits`. */
    missingCategories: z.array(CategorySchema),
    message: z.string(),
  }),
]);
export type OutfitGenerationResponse = z.infer<typeof OutfitGenerationResponseSchema>;

// ---------------------------------------------------------------------------
// Composition rule (spec "Pipeline", step 2)
// ---------------------------------------------------------------------------

export type CompositionResult = { ok: true } | { ok: false; problem: string };

/**
 * The rule that makes an outfit wearable: either one top + one bottom, or one
 * dress/jumpsuit; plus exactly one pair of shoes; plus at most one outerwear.
 * v1 has no layering (one top only). Pass one category per item.
 */
export function checkComposition(categories: readonly Category[]): CompositionResult {
  const count = (c: Category) => categories.filter((x) => x === c).length;
  const tops = count("top");
  const bottoms = count("bottom");
  const dresses = count("dress_jumpsuit");
  const shoes = count("shoes");
  const outerwear = count("outerwear");

  const separates = tops === 1 && bottoms === 1 && dresses === 0;
  const onePiece = dresses === 1 && tops === 0 && bottoms === 0;

  if (!separates && !onePiece) {
    return { ok: false, problem: "Needs one top and one bottom, or one dress or jumpsuit" };
  }
  if (shoes !== 1) return { ok: false, problem: "Needs exactly one pair of shoes" };
  if (outerwear > 1) return { ok: false, problem: "At most one piece of outerwear" };
  return { ok: true };
}

/**
 * Which categories the wardrobe would need before any outfit is possible.
 * Returns [] when at least one valid combination exists.
 */
export function missingCategoriesForOutfits(present: ReadonlySet<Category>): Category[] {
  const missing: Category[] = [];
  const hasBody = present.has("dress_jumpsuit") || (present.has("top") && present.has("bottom"));
  if (!hasBody) {
    // Suggest the cheapest fix: whichever separates are missing.
    if (!present.has("top")) missing.push("top");
    if (!present.has("bottom")) missing.push("bottom");
  }
  if (!present.has("shoes")) missing.push("shoes");
  return missing;
}
