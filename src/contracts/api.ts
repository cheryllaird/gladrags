/**
 * Request and response shapes for every API route. docs/CONTRACTS.md
 * describes each route in plain language; keep the two in step.
 *
 * Errors from any route use ApiErrorSchema (see common.ts).
 */
import { z } from "zod";
import { IdSchema, singleLineText } from "./common";
import {
  CategorySchema,
  ColourSchema,
  ImageKeySchema,
  ImageUrlSchema,
  ItemDraftSchema,
  ItemSourceSchema,
  ItemTagsSchema,
  SourceUrlSchema,
  WardrobeItemSchema,
  emptyToNull,
} from "./item";
import { OutfitSchema, OutfitStatusSchema } from "./outfit";
import { PresetStyleIdSchema } from "./styles";

// Other route bodies live next to their domain types:
// OutfitRequestSchema and OutfitGenerationResponseSchema (outfit.ts),
// RefineRequestSchema and UpdateOutfitStatusRequestSchema (feedback.ts),
// UsageSummarySchema (usage.ts).

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

/** Route params like /api/items/[id]. */
export const IdParamsSchema = z.object({ id: IdSchema });

export const DeletedResponseSchema = z.object({ deleted: z.literal(true) });
export type DeletedResponse = z.infer<typeof DeletedResponseSchema>;

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/** A same-site path to return to after sign-in. Blocks "//evil.com" style open redirects. */
export const ReturnPathSchema = z.string().regex(/^\/(?!\/)[^\s\\]*$/, { error: "Must be a path on this site" }).max(512);

/** POST /api/auth/magic-link */
export const MagicLinkRequestSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email({ error: "Enter a valid email address" }).max(254)),
  next: ReturnPathSchema.optional(),
});
export type MagicLinkRequest = z.infer<typeof MagicLinkRequestSchema>;
export const MagicLinkResponseSchema = z.object({ sent: z.literal(true) });
export type MagicLinkResponse = z.infer<typeof MagicLinkResponseSchema>;

/**
 * POST /api/auth/verify-code: sign in by typing the code from the email.
 * Needed for the installed PWA on iPhone, where tapping the emailed link
 * opens Safari (which doesn't share cookies with the home-screen app).
 */
export const VerifyCodeRequestSchema = z.object({
  email: MagicLinkRequestSchema.shape.email,
  code: z.string().trim().regex(/^\d{6,10}$/, { error: "Enter the code from the email" }),
  next: ReturnPathSchema.optional(),
});
export type VerifyCodeRequest = z.infer<typeof VerifyCodeRequestSchema>;
export const VerifyCodeResponseSchema = z.object({ signedIn: z.literal(true), next: ReturnPathSchema });
export type VerifyCodeResponse = z.infer<typeof VerifyCodeResponseSchema>;

/** POST /api/auth/sign-out */
export const SignOutResponseSchema = z.object({ signedOut: z.literal(true) });

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

/** GET /api/items query string. All filters optional and combined with AND. */
export const ItemListQuerySchema = z.object({
  category: CategorySchema.optional(),
  colour: ColourSchema.optional(),
  occasion: PresetStyleIdSchema.optional(),
  /** Case-insensitive search on the description. */
  q: z.string().trim().max(100).optional(),
});
export type ItemListQuery = z.infer<typeof ItemListQuerySchema>;
export const ItemListResponseSchema = z.object({ items: z.array(WardrobeItemSchema) });
export type ItemListResponse = z.infer<typeof ItemListResponseSchema>;

/** GET/PATCH /api/items/[id] and POST /api/items */
export const ItemResponseSchema = z.object({ item: WardrobeItemSchema });
export type ItemResponse = z.infer<typeof ItemResponseSchema>;

/** POST /api/items: save a reviewed draft as a wardrobe item. */
export const CreateItemRequestSchema = z
  .object({
    source: ItemSourceSchema,
    sourceUrl: SourceUrlSchema.nullable(),
    originalImageKey: ImageKeySchema,
    /** Null when the phone couldn't cut the item out. */
    cutoutImageKey: ImageKeySchema.nullable(),
    tags: ItemTagsSchema,
    /** True if the user changed any suggested tag, or tagging failed and they filled them in. */
    tagsEdited: z.boolean(),
  })
  .refine((req) => req.source !== "link" || req.sourceUrl !== null, {
    path: ["sourceUrl"],
    error: "Items added by link must keep their source URL",
  });
export type CreateItemRequest = z.infer<typeof CreateItemRequestSchema>;

/** PATCH /api/items/[id]: replace the item's tags (the edit form sends all of them). */
export const UpdateItemRequestSchema = z.object({ tags: ItemTagsSchema });
export type UpdateItemRequest = z.infer<typeof UpdateItemRequestSchema>;

/** Returned by POST /api/items/photo and POST /api/items/link/cutout. */
export const ItemDraftResponseSchema = z.object({ draft: ItemDraftSchema });
export type ItemDraftResponse = z.infer<typeof ItemDraftResponseSchema>;

/**
 * Multipart field names. The two upload routes are multipart/form-data, not
 * JSON, because they carry image files.
 */
export const UPLOAD_FIELDS = {
  /** The resized photo (JPEG, PNG or WebP; ≤ 1600 px; ≤ MAX_ORIGINAL_BYTES). */
  original: "original",
  /** Optional cut-out made on the phone (PNG; ≤ 1600 px; ≤ MAX_CUTOUT_BYTES). */
  cutout: "cutout",
  /** Text fields, validated by the schemas below. */
  sourceUrl: "sourceUrl",
  meta: "meta",
} as const;

/**
 * POST /api/items/photo (multipart): add an item from a photo or screenshot.
 * Files: `original` (required), `cutout` (optional; leave it out if
 * background removal failed on the phone). Text field `sourceUrl`
 * (optional): set when this is the screenshot fallback for a link, so the
 * item keeps its link. The server strips EXIF from both images, checks
 * their type, size and dimensions, stores them, and tags the cut-out if
 * there is one, otherwise the original.
 */
export const PhotoUploadFieldsSchema = z.object({
  sourceUrl: SourceUrlSchema.optional(),
});

/** POST /api/items/link, step 1 of 2: read the product page. */
export const LinkImportRequestSchema = z.object({ url: SourceUrlSchema });
export type LinkImportRequest = z.infer<typeof LinkImportRequestSchema>;

/**
 * Removes half of a surrogate pair, e.g. an emoji cut in two by a length
 * limit. Postgres jsonb rejects lone surrogates, so they must never be stored.
 */
function dropLoneSurrogates(text: string): string {
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}

/**
 * Text scraped from a web page, on its way into a model prompt: whitespace
 * (including newlines) collapsed to single spaces, cut to `max` characters,
 * and "" read as null. After that it must be a single line, like every
 * other prompt-bound text.
 */
export function scrapedText(max: number) {
  return z.preprocess((value) => {
    if (typeof value !== "string") return emptyToNull(value);
    const flat = dropLoneSurrogates(value.replace(/\s+/g, " ").trim().slice(0, max)).trim();
    return flat === "" ? null : flat;
  }, singleLineText(max).nullable());
}

export const LINK_PRODUCT_LIMITS = { title: 200, brand: 80, colour: 60 } as const;

/** What the product page told us. Any field may be missing. */
export const LinkProductSchema = z.object({
  title: scrapedText(LINK_PRODUCT_LIMITS.title),
  brand: scrapedText(LINK_PRODUCT_LIMITS.brand),
  colour: scrapedText(LINK_PRODUCT_LIMITS.colour),
});
export type LinkProduct = z.infer<typeof LinkProductSchema>;

export const LINK_FALLBACK_REASONS = [
  "fetch_blocked", // site refused, timed out or isn't a public web page
  "no_product_data", // no Open Graph / JSON-LD product data
  "no_image", // product data found but no image we could download and use
] as const;

/** How long the step-1 image URL lasts: long enough to cut the item out. */
export const LINK_IMAGE_URL_TTL_SECONDS = 10 * 60;

/**
 * How long a step-1 import can wait for step 2. After this, or once step 2
 * has run, the import is spent and step 2 answers not_found.
 */
export const LINK_IMPORT_TTL_SECONDS = 60 * 60;

/**
 * Step 1 result. `ok`: the server fetched the page, downloaded the product
 * image (resized to ≤ 1600 px, EXIF stripped), stored it as the original,
 * and recorded the import (source URL and product data) in the
 * link_imports table. The client loads `originalUrl`, cuts the item out,
 * and calls step 2. `product` is for display only: step 2 uses the
 * server's own copy.
 *
 * `needs_screenshot` is the spec's fallback: ask for a screenshot of the
 * product and send it to POST /api/items/photo with this `sourceUrl`.
 */
export const LinkImportResponseSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    sourceUrl: SourceUrlSchema,
    originalImageKey: ImageKeySchema,
    /** Short-lived signed URL (LINK_IMAGE_URL_TTL_SECONDS) for the stored product image. */
    originalUrl: ImageUrlSchema,
    product: LinkProductSchema,
  }),
  z.object({
    status: z.literal("needs_screenshot"),
    reason: z.enum(LINK_FALLBACK_REASONS),
    sourceUrl: SourceUrlSchema,
    message: z.string(),
  }),
]);
export type LinkImportResponse = z.infer<typeof LinkImportResponseSchema>;

/**
 * POST /api/items/link/cutout (multipart), step 2 of 2: attach the cut-out
 * and tag the item. Text field `meta` is JSON matching this schema: just
 * the step-1 `originalImageKey`, which identifies the import. The server
 * looks up the source URL and product data it stored in step 1; anything
 * else the client sends is ignored. File `cutout` is optional: leave it out
 * if background removal failed, and the server tags the original instead.
 *
 * Single use: each import can be tagged once. A second call, an expired
 * import, or someone else's key gets not_found. Counts one item_ingest
 * against the daily cap. Returns ItemDraftResponseSchema.
 */
export const LinkCutoutMetaSchema = z.object({
  originalImageKey: ImageKeySchema,
});
export type LinkCutoutMeta = z.infer<typeof LinkCutoutMetaSchema>;

// ---------------------------------------------------------------------------
// Outfits
// ---------------------------------------------------------------------------

/** GET /api/outfits query string, e.g. ?status=saved for the saved outfits screen. */
export const OutfitListQuerySchema = z.object({ status: OutfitStatusSchema.optional() });
export type OutfitListQuery = z.infer<typeof OutfitListQuerySchema>;
export const OutfitListResponseSchema = z.object({ outfits: z.array(OutfitSchema) });
export type OutfitListResponse = z.infer<typeof OutfitListResponseSchema>;

/** GET/PATCH /api/outfits/[id] */
export const OutfitResponseSchema = z.object({ outfit: OutfitSchema });
export type OutfitResponse = z.infer<typeof OutfitResponseSchema>;
