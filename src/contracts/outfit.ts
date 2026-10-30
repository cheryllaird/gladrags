import { z } from "zod";
import { IdSchema, TimestampSchema, emptyToNull, singleLineText } from "./common";
import {
  CategorySchema,
  ColourSchema,
  DESCRIPTION_MAX_LENGTH,
  MAX_COLOURS,
  SubcategorySchema,
  WardrobeItemSchema,
  isSubcategoryOf,
  uniqueArray,
  type Category,
} from "./item";
import { ShopProductSchema, SHOP_PRODUCTS_PER_GAP } from "./shops";
import { StyleChoiceSchema } from "./styles";

export const OUTFIT_STATUSES = ["suggested", "saved", "liked", "rejected"] as const;
export const OutfitStatusSchema = z.enum(OUTFIT_STATUSES);
export type OutfitStatus = z.infer<typeof OutfitStatusSchema>;

export const OUTFIT_COUNT = { default: 4, min: 3, max: 5 } as const;
export const GUIDANCE_MAX_LENGTH = 200;
export const OUTFIT_NAME_MAX_LENGTH = 40;
export const OUTFIT_REASON_MAX_LENGTH = 160;

/**
 * Slots in one outfit, owned items and gaps together. The smallest outfit
 * is dress + shoes; the largest is top + bottom + shoes + outerwear.
 */
export const OUTFIT_SLOT_COUNT = { min: 2, max: 4 } as const;

/**
 * Owned items in one outfit. At least one (spec: "every outfit has at
 * least one owned item"); the rest of the slots may be gaps.
 */
export const OUTFIT_ITEM_COUNT = { min: 1, max: OUTFIT_SLOT_COUNT.max } as const;

/** Gaps in one outfit: every slot but the one owned item. */
export const MAX_GAPS_PER_OUTFIT = OUTFIT_SLOT_COUNT.max - OUTFIT_ITEM_COUNT.min;

/**
 * With "Include items from my shops" on, at most this many gaps per outfit
 * may be in a category the wardrobe could have filled (orchestrator
 * decision). Gaps for categories the wardrobe is missing don't count.
 */
export const MAX_SHOP_ITEM_GAPS = 1;

export const GuidanceSchema = singleLineText(GUIDANCE_MAX_LENGTH);

/** Body of POST /api/outfits. */
export const OutfitRequestSchema = z.object({
  style: StyleChoiceSchema,
  /** Build outfits around this item ("build an outfit around this"). */
  anchorItemId: IdSchema.optional(),
  /** Free text such as "no heels" or "use my green dress". */
  guidance: GuidanceSchema.optional(),
  count: z.int().min(OUTFIT_COUNT.min).max(OUTFIT_COUNT.max).default(OUTFIT_COUNT.default),
  /**
   * "Include items from my shops": outfits may include one suggested shop
   * item (a gap) even where the wardrobe could fill the slot. Gaps for
   * categories the wardrobe is missing happen either way.
   */
  includeShopItems: z.boolean().optional(),
});
export type OutfitRequest = z.infer<typeof OutfitRequestSchema>;
/** What callers send: `count` may be left out. A missing `includeShopItems` means false. */
export type OutfitRequestInput = z.input<typeof OutfitRequestSchema>;

/** The request as stored on each outfit row (outfits.request jsonb). */
export const StoredOutfitRequestSchema = z.object({
  style: StyleChoiceSchema,
  guidance: GuidanceSchema.nullable(),
  anchorItemId: IdSchema.nullable(),
  /** Missing on outfits saved before milestone 5, which read as false. */
  includeShopItems: z.boolean().default(false),
});
export type StoredOutfitRequest = z.infer<typeof StoredOutfitRequestSchema>;

/** No item twice in one outfit. */
export const OutfitItemIdsSchema = z
  .array(IdSchema)
  .min(OUTFIT_ITEM_COUNT.min)
  .max(OUTFIT_ITEM_COUNT.max)
  .refine((ids) => new Set(ids).size === ids.length, { error: "An item can't appear twice in one outfit" });

// ---------------------------------------------------------------------------
// Gaps (spec: "Gaps and shop suggestions")
// ---------------------------------------------------------------------------

/**
 * A slot the wardrobe doesn't fill, as the model describes it: the item
 * that would complete the look ("White leather trainers"). The same shape
 * is used in the model's output and, with the shop fields added, on stored
 * outfits.
 */
const gapDescriptionShape = {
  category: CategorySchema,
  /** Null when the model doesn't narrow it down. A blank value reads as null. */
  subcategory: z.preprocess(emptyToNull, SubcategorySchema.nullable()),
  /** colours[0] is the main colour; from the fixed palette, like item tags. */
  colours: uniqueArray(ColourSchema, 1, MAX_COLOURS),
  /** One line, e.g. "White leather trainers". Shown on the collage placeholder and used as the shop search. */
  description: singleLineText(DESCRIPTION_MAX_LENGTH),
};

function subcategoryMatches(gap: { category: Category; subcategory: string | null }, ctx: z.RefinementCtx) {
  if (gap.subcategory !== null && !isSubcategoryOf(gap.category, gap.subcategory)) {
    ctx.addIssue({ code: "custom", path: ["subcategory"], message: `"${gap.subcategory}" is not a ${gap.category} subcategory` });
  }
}

/** A gap as the ranking model returns it. */
export const GapDescriptionSchema = z.object(gapDescriptionShape).superRefine(subcategoryMatches);
export type GapDescription = z.infer<typeof GapDescriptionSchema>;

/**
 * A gap on a stored outfit (outfits.gaps jsonb, and the API). Adds what
 * "Find in my shops" found and what the user picked.
 */
export const OutfitGapSchema = z
  .object({
    ...gapDescriptionShape,
    /**
     * The last "Find in my shops" results for this gap: up to three
     * products, each checked on the shop's website. Empty until searched,
     * or if nothing was found. Replaced by each new search.
     */
    shopResults: z.array(ShopProductSchema).max(SHOP_PRODUCTS_PER_GAP).default([]),
    /** When this gap was last searched; null if never. */
    searchedAt: TimestampSchema.nullable().default(null),
    /**
     * The product the user picked (one of shopResults when they picked it),
     * or null. The collage shows its image in the slot.
     */
    shopProduct: ShopProductSchema.nullable().default(null),
  })
  .superRefine(subcategoryMatches);
export type OutfitGap = z.infer<typeof OutfitGapSchema>;
export type OutfitGapInput = z.input<typeof OutfitGapSchema>;

/** At most MAX_GAPS_PER_OUTFIT gaps, never two in the same category. */
function gapList<T extends z.ZodType<{ category: Category }>>(gap: T) {
  return z
    .array(gap)
    .max(MAX_GAPS_PER_OUTFIT)
    .refine((gaps) => new Set(gaps.map((g) => g.category)).size === gaps.length, {
      error: "Two gaps can't fill the same slot",
    });
}

export const OutfitGapsSchema = gapList(OutfitGapSchema);
export const GapDescriptionsSchema = gapList(GapDescriptionSchema);

// ---------------------------------------------------------------------------
// Outfits
// ---------------------------------------------------------------------------

/** An outfit as the API returns it, with its items included for the collage. */
export const OutfitSchema = z
  .object({
    id: IdSchema,
    request: StoredOutfitRequestSchema,
    name: singleLineText(OUTFIT_NAME_MAX_LENGTH),
    reason: singleLineText(OUTFIT_REASON_MAX_LENGTH),
    /** The owned items: at least one. */
    itemIds: OutfitItemIdsSchema,
    /** Same items as itemIds, in the same order. */
    items: z.array(WardrobeItemSchema),
    /** Slots the wardrobe doesn't fill, described by the model. Empty for a complete outfit. */
    gaps: OutfitGapsSchema.default([]),
    status: OutfitStatusSchema,
    /** Set when this outfit came from refining another one. */
    parentOutfitId: IdSchema.nullable(),
    createdAt: TimestampSchema,
  })
  .refine((o) => o.itemIds.length + o.gaps.length <= OUTFIT_SLOT_COUNT.max, {
    path: ["gaps"],
    error: `An outfit has at most ${OUTFIT_SLOT_COUNT.max} pieces`,
  });
export type Outfit = z.infer<typeof OutfitSchema>;
export type OutfitInput = z.input<typeof OutfitSchema>;

/** True if any of the outfit's slots is a gap. */
export function hasGaps(outfit: { gaps: readonly unknown[] }): boolean {
  return outfit.gaps.length > 0;
}

/**
 * Response of POST /api/outfits and POST /api/outfits/[id]/refine.
 * `incomplete_wardrobe` is a normal outcome, not an error.
 */
const IncompleteWardrobeSchema = z
  .object({
    status: z.literal("incomplete_wardrobe"),
    /**
     * `empty_wardrobe`: the wardrobe has no items at all, so no outfit can
     * have an owned item. The UI points to the get-started checklist.
     * `nothing_fits`: there are items, but none can start an outfit for
     * this style (or anchor).
     * `missing_category`: LEGACY, from before gaps. No valid combination
     * exists without gaps. The engine stops returning it in milestone 5
     * (outfits with gaps instead); it stays valid until the engine and UI
     * branches have both merged, then is removed.
     */
    reason: z.enum(["empty_wardrobe", "nothing_fits", "missing_category"]),
    /**
     * For `missing_category` only (at least one): categories that would
     * unlock outfits, from missingCategoriesForOutfits. Empty otherwise.
     */
    missingCategories: z.array(CategorySchema),
    message: z.string(),
  })
  .refine((r) => (r.reason === "missing_category") === r.missingCategories.length > 0, {
    path: ["missingCategories"],
    error: "List the missing categories for missing_category, and none otherwise",
  });

export const OutfitGenerationResponseSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    outfits: z.array(OutfitSchema).min(1).max(OUTFIT_COUNT.max),
    /**
     * Categories the wardrobe is missing for this request (taking the anchor
     * into account: missingCategoriesForOutfits), whose slots were filled
     * with gaps. The UI suggests adding them ("Add shoes to complete these
     * outfits"). Empty when the wardrobe has everything.
     */
    missingCategories: z.array(CategorySchema).default([]),
  }),
  IncompleteWardrobeSchema,
]);
export type OutfitGenerationResponse = z.infer<typeof OutfitGenerationResponseSchema>;
export type OutfitGenerationResponseInput = z.input<typeof OutfitGenerationResponseSchema>;

// ---------------------------------------------------------------------------
// Composition rule (spec "Pipeline", step 2)
// ---------------------------------------------------------------------------

export type CompositionResult = { ok: true } | { ok: false; problem: string };

/**
 * The rule that makes an outfit wearable: either one top + one bottom, or one
 * dress/jumpsuit; plus exactly one pair of shoes; plus at most one outerwear.
 * v1 has no layering (one top only).
 *
 * Pass one category per owned item, and one per gap. A slot can be filled
 * by an owned item or a gap, but at least one slot must be an owned item.
 * (That the anchor item is owned and included is checked by
 * checkRankedOutfits.)
 */
export function checkComposition(itemCategories: readonly Category[], gapCategories: readonly Category[] = []): CompositionResult {
  if (itemCategories.length === 0) {
    return { ok: false, problem: "Needs at least one item from the wardrobe" };
  }
  const categories = [...itemCategories, ...gapCategories];
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
 * Which categories the wardrobe would need before a complete outfit (no
 * gaps) is possible. Returns [] when at least one complete combination
 * exists. Since milestone 5 the engine fills these slots with gaps and
 * returns this list as the response's `missingCategories`.
 *
 * Pass the anchor item's category when the request is built around one:
 * the anchor fixes part of the outfit. With a top as the anchor, a dress in
 * the wardrobe doesn't help, so a missing bottom is reported.
 */
export function missingCategoriesForOutfits(present: ReadonlySet<Category>, anchorCategory?: Category): Category[] {
  const missing: Category[] = [];
  const need = (c: Category) => {
    if (!present.has(c)) missing.push(c);
  };

  switch (anchorCategory) {
    case "top":
      need("bottom");
      break;
    case "bottom":
      need("top");
      break;
    case "dress_jumpsuit":
      break;
    default: {
      // No anchor, or shoes/outerwear: any body works.
      const hasBody = present.has("dress_jumpsuit") || (present.has("top") && present.has("bottom"));
      if (!hasBody) {
        // Suggest the cheapest fix: whichever separates are missing.
        need("top");
        need("bottom");
      }
    }
  }
  if (anchorCategory !== "shoes") need("shoes");
  return missing;
}
