import { z } from "zod";
import { IdSchema, TimestampSchema, singleLineText } from "./common";
import { PresetStyleIdSchema } from "./styles";

// ---------------------------------------------------------------------------
// Tag vocabularies
// ---------------------------------------------------------------------------

export const CATEGORIES = ["top", "bottom", "dress_jumpsuit", "outerwear", "shoes"] as const;
export const CategorySchema = z.enum(CATEGORIES);
export type Category = z.infer<typeof CategorySchema>;

/**
 * Subcategories per category. Top, bottom and outerwear are exactly the
 * spec's lists. The spec doesn't list subcategories for "dress or jumpsuit"
 * or "shoes", so those two lists are a foundations decision for Cheryl.
 */
export const SUBCATEGORIES = {
  top: ["t_shirt", "shirt", "blouse", "polo", "jumper"],
  bottom: ["jeans", "trousers", "chinos", "skirt", "shorts"],
  dress_jumpsuit: ["dress", "jumpsuit"],
  outerwear: ["jacket", "blazer", "coat"],
  shoes: ["trainers", "boots", "sandals", "heels", "flats", "loafers", "smart_shoes"],
} as const satisfies Record<Category, readonly string[]>;

export type Subcategory = (typeof SUBCATEGORIES)[Category][number];
export type SubcategoryOf<C extends Category> = (typeof SUBCATEGORIES)[C][number];

export const ALL_SUBCATEGORIES = Object.values(SUBCATEGORIES).flat() as [Subcategory, ...Subcategory[]];
export const SubcategorySchema = z.enum(ALL_SUBCATEGORIES);

export function isSubcategoryOf(category: Category, subcategory: string): boolean {
  return (SUBCATEGORIES[category] as readonly string[]).includes(subcategory);
}

/**
 * A fixed colour palette so the wardrobe can be filtered by colour and the
 * model can't invent names like "dusty heather". Not in the spec: decision
 * for Cheryl.
 */
export const COLOURS = [
  "black",
  "white",
  "cream",
  "beige",
  "tan",
  "brown",
  "grey",
  "navy",
  "blue",
  "light_blue",
  "teal",
  "green",
  "olive",
  "yellow",
  "orange",
  "red",
  "burgundy",
  "pink",
  "purple",
  "gold",
  "silver",
] as const;
export const ColourSchema = z.enum(COLOURS);
export type Colour = z.infer<typeof ColourSchema>;

/** First entry is the primary colour; up to two secondary colours follow. */
export const MAX_COLOURS = 3;

export const PATTERNS = ["plain", "stripe", "floral", "check", "print"] as const;
export const PatternSchema = z.enum(PATTERNS);
export type Pattern = z.infer<typeof PatternSchema>;

/** 1 = loungewear … 5 = formal. */
export const FormalitySchema = z.int().min(1).max(5);
export type Formality = z.infer<typeof FormalitySchema>;

/** UK spelling. Not enumerated in the spec: decision for Cheryl. */
export const SEASONS = ["spring", "summer", "autumn", "winter"] as const;
export const SeasonSchema = z.enum(SEASONS);
export type Season = z.infer<typeof SeasonSchema>;

/**
 * How warm the item is to wear. Not enumerated in the spec: decision for
 * Cheryl. "light" = linen shirt, sandals; "medium" = jeans, cotton jumper;
 * "warm" = wool coat, chunky knit, boots.
 */
export const WARMTH_LEVELS = ["light", "medium", "warm"] as const;
export const WarmthSchema = z.enum(WARMTH_LEVELS);
export type Warmth = z.infer<typeof WarmthSchema>;

export const ITEM_SOURCES = ["photo", "link"] as const;
export const ItemSourceSchema = z.enum(ITEM_SOURCES);
export type ItemSource = z.infer<typeof ItemSourceSchema>;

export const FABRIC_MAX_LENGTH = 40;
export const DESCRIPTION_MAX_LENGTH = 120;

// ---------------------------------------------------------------------------
// Item tags
// ---------------------------------------------------------------------------

function uniqueArray<T extends z.ZodType>(item: T, min: number, max: number) {
  return z
    .array(item)
    .min(min)
    .max(max)
    .refine((values) => new Set(values).size === values.length, { error: "No duplicates" });
}

const itemTagsShape = {
  category: CategorySchema,
  subcategory: SubcategorySchema,
  /** colours[0] is the primary colour. */
  colours: uniqueArray(ColourSchema, 1, MAX_COLOURS),
  pattern: PatternSchema,
  formality: FormalitySchema,
  /** All four seasons means "all year". */
  seasons: uniqueArray(SeasonSchema, 1, SEASONS.length),
  warmth: WarmthSchema,
  /** Preset styles this item suits. */
  occasions: uniqueArray(PresetStyleIdSchema, 1, 9),
  /** Main fabric where visible ("denim", "wool"), otherwise null. */
  fabric: singleLineText(FABRIC_MAX_LENGTH).nullable(),
  /** One line, e.g. "Navy slim-fit chinos". Searchable in the wardrobe. */
  description: singleLineText(DESCRIPTION_MAX_LENGTH),
};

/**
 * The complete tag set an item must have before it can be saved. Shared by
 * the tag review form, the items API and the tagging model's output.
 */
export const ItemTagsSchema = z.object(itemTagsShape).superRefine((tags, ctx) => {
  if (!isSubcategoryOf(tags.category, tags.subcategory)) {
    ctx.addIssue({
      code: "custom",
      path: ["subcategory"],
      message: `"${tags.subcategory}" is not a ${tags.category} subcategory`,
    });
  }
});
export type ItemTags = z.infer<typeof ItemTagsSchema>;

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

/** Buckets in Supabase Storage. Both private; served through signed URLs. */
export const STORAGE_BUCKETS = { originals: "originals", cutouts: "cutouts" } as const;

/**
 * Object key inside a bucket: `<user id>/<uuid>.<ext>`. The first folder must
 * be the owner's user ID; storage RLS relies on it.
 */
export const ImageKeySchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$/,
    { error: "Not a valid image key" },
  );

export function imageKeyBelongsTo(key: string, userId: string): boolean {
  return key.startsWith(`${userId}/`);
}

/**
 * Upload limits. Background removal runs in the browser, so one upload
 * carries the original photo and (optionally) its cut-out. Vercel caps a
 * request body at 4.5 MB, so the two files share a 4 MB budget:
 *
 * - original: JPEG, PNG or WebP, at most 1600 px on its longest side
 *   (the client resizes first) and 1.5 MB. A 1600 px JPEG at quality ~0.85
 *   is usually well under 1 MB.
 * - cut-out: PNG with transparency, at most 1600 px and 2.5 MB. If the PNG
 *   comes out bigger, the client scales the cut-out down until it fits.
 *
 * The server re-checks type (from the file bytes, not the declared type),
 * byte size and pixel dimensions, and strips EXIF from both.
 */
export const MAX_IMAGE_DIMENSION_PX = 1600;
export const MAX_ORIGINAL_BYTES = 1.5 * 1024 * 1024;
export const MAX_CUTOUT_BYTES = 2.5 * 1024 * 1024;
export const ACCEPTED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export const AcceptedImageTypeSchema = z.enum(ACCEPTED_IMAGE_TYPES);
export type AcceptedImageType = z.infer<typeof AcceptedImageTypeSchema>;
/** Cut-outs must be PNG so the transparent background survives. */
export const CUTOUT_IMAGE_TYPE = "image/png" as const;

/** A link or URL the user pasted. http(s) only. */
export const SourceUrlSchema = z.url({ protocol: /^https?$/, error: "Must be an http or https link" }).max(2048);

/**
 * Short-lived signed URL for an image. In mock mode these are relative paths
 * under /mock, so this is a non-empty string rather than a strict URL.
 */
export const ImageUrlSchema = z.string().min(1);

// ---------------------------------------------------------------------------
// Items as the API returns them
// ---------------------------------------------------------------------------

export const WardrobeItemSchema = z.object({
  id: IdSchema,
  source: ItemSourceSchema,
  sourceUrl: SourceUrlSchema.nullable(),
  originalUrl: ImageUrlSchema,
  /** Null when background removal failed on the phone: show originalUrl instead (see displayImageUrl). */
  cutoutUrl: ImageUrlSchema.nullable(),
  tags: ItemTagsSchema,
  /** True if the user changed any auto-filled tag (feeds the "4 in 5" success measure). */
  tagsEdited: z.boolean(),
  createdAt: TimestampSchema,
});
export type WardrobeItem = z.infer<typeof WardrobeItemSchema>;

/** The image to show for an item: the cut-out, or the original if there isn't one. */
export function displayImageUrl(item: { cutoutUrl: string | null; originalUrl: string }): string {
  return item.cutoutUrl ?? item.originalUrl;
}

/**
 * An uploaded, tagged item that hasn't been saved yet. Returned by
 * POST /api/items/photo and POST /api/items/link/cutout; the user reviews
 * `suggestedTags` and then saves with POST /api/items.
 */
export const ItemDraftSchema = z.object({
  source: ItemSourceSchema,
  sourceUrl: SourceUrlSchema.nullable(),
  originalImageKey: ImageKeySchema,
  /** Null when the phone couldn't remove the background. */
  cutoutImageKey: ImageKeySchema.nullable(),
  originalUrl: ImageUrlSchema,
  cutoutUrl: ImageUrlSchema.nullable(),
  /** Null when tagging failed twice: the user fills the tags in from scratch. */
  suggestedTags: ItemTagsSchema.nullable(),
});
export type ItemDraft = z.infer<typeof ItemDraftSchema>;
