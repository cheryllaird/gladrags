/**
 * Request and response shapes for every API route. docs/CONTRACTS.md
 * describes each route in plain language; keep the two in step.
 *
 * Errors from any route use ApiErrorSchema (see common.ts).
 */
import { z } from "zod";
import { IdSchema, scrapedText } from "./common";
import { EmailImportSchema, InboundWebhookResponseSchema } from "./email";
import {
  CategorySchema,
  ColourSchema,
  DraftSourceSchema,
  ImageKeySchema,
  ImageUrlSchema,
  ItemDraftSchema,
  ItemTagsSchema,
  SourceUrlSchema,
  WardrobeItemSchema,
} from "./item";
import { OutfitSchema, OutfitStatusSchema } from "./outfit";
import { FavouriteShopIdsSchema } from "./shops";
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
  /**
   * `?needsReview=true`: only items still marked "to review" (the review
   * list, and its count for the "Review N new items" banner).
   * `?needsReview=false`: only reviewed items.
   */
  needsReview: z.stringbool().optional(),
});
export type ItemListQuery = z.infer<typeof ItemListQuerySchema>;
export const ItemListResponseSchema = z.object({ items: z.array(WardrobeItemSchema) });
export type ItemListResponse = z.infer<typeof ItemListResponseSchema>;

/** GET/PATCH /api/items/[id], POST /api/items, and the item image routes. */
export const ItemResponseSchema = z.object({ item: WardrobeItemSchema });
export type ItemResponse = z.infer<typeof ItemResponseSchema>;

/** POST /api/items: save a reviewed draft as a wardrobe item. Saved items are never "to review". */
export const CreateItemRequestSchema = z
  .object({
    source: DraftSourceSchema,
    sourceUrl: SourceUrlSchema.nullable(),
    originalImageKey: ImageKeySchema,
    /** The draft's cutoutImageKey: null unless an older client sent a cut-out with the photo. */
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

/**
 * PATCH /api/items/[id]. Either or both of:
 * - `tags`: replace all the tags (the edit form sends all of them); sets tagsEdited.
 * - `reviewed: true`: confirm the suggested tags as they are.
 * Every successful PATCH also clears needsReview: correcting tags in the
 * review list counts as reviewing them.
 */
export const UpdateItemRequestSchema = z
  .object({
    tags: ItemTagsSchema.optional(),
    reviewed: z.literal(true).optional(),
  })
  .refine((req) => req.tags !== undefined || req.reviewed !== undefined, {
    error: "Send tags, or reviewed: true",
  });
export type UpdateItemRequest = z.infer<typeof UpdateItemRequestSchema>;

/** Most items one "Confirm all" can mark reviewed. */
export const MAX_ITEMS_PER_REVIEW = 100;

/** POST /api/items/reviewed: "Confirm all" in the review list. Item IDs that aren't the user's are ignored. */
export const MarkItemsReviewedRequestSchema = z.object({
  itemIds: z
    .array(IdSchema)
    .min(1)
    .max(MAX_ITEMS_PER_REVIEW)
    .refine((ids) => new Set(ids).size === ids.length, { error: "No duplicates" }),
});
export type MarkItemsReviewedRequest = z.infer<typeof MarkItemsReviewedRequestSchema>;
/** How many of the user's items were marked reviewed (ones already reviewed count too). */
export const MarkItemsReviewedResponseSchema = z.object({ updated: z.int().min(0) });
export type MarkItemsReviewedResponse = z.infer<typeof MarkItemsReviewedResponseSchema>;

/** Returned by POST /api/items/photo and POST /api/items/link/cutout for a single add. */
export const ItemDraftResponseSchema = z.object({ draft: ItemDraftSchema });
export type ItemDraftResponse = z.infer<typeof ItemDraftResponseSchema>;

/**
 * Returned by POST /api/items/photo and POST /api/items/link/cutout when
 * `saveForReview` is set (a batch add):
 * - `saved`: the item was saved straight away with its suggested tags,
 *   marked "to review" (needsReview: true).
 * - `draft`: tagging failed twice, so there were no tags to save it with.
 *   `draft.suggestedTags` is null; the review list shows it as a draft for
 *   the user to fill in and save with POST /api/items, as for a single add.
 */
export const BatchAddResponseSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("saved"), item: WardrobeItemSchema }),
  z.object({ status: z.literal("draft"), draft: ItemDraftSchema }),
]);
export type BatchAddResponse = z.infer<typeof BatchAddResponseSchema>;

/**
 * Multipart field names. The upload routes are multipart/form-data, not
 * JSON, because they carry image files.
 */
export const UPLOAD_FIELDS = {
  /** The resized photo (JPEG, PNG or WebP; ≤ 1600 px; ≤ MAX_ORIGINAL_BYTES). */
  original: "original",
  /** A cut-out made on the phone (PNG; ≤ 1600 px; ≤ MAX_CUTOUT_BYTES). */
  cutout: "cutout",
  /** Text fields, validated by the schemas below. */
  sourceUrl: "sourceUrl",
  meta: "meta",
  /** "true" for a batch add: save the item as "to review" instead of returning a draft. */
  saveForReview: "saveForReview",
} as const;

/**
 * POST /api/items/photo (multipart): add an item from a photo or screenshot.
 *
 * - File `original` (required).
 * - File `cutout` (optional, DEPRECATED): since milestone 5 the add flow
 *   doesn't cut the item out; collages do, later, with
 *   PUT /api/items/[id]/cutout. Still accepted (and checked as before) so
 *   older clients keep working; to be removed once the new add flow ships.
 * - Text field `sourceUrl` (optional): set when this is the screenshot
 *   fallback for a link, so the item keeps its link.
 * - Text field `saveForReview` (optional, "true" or "false"): "true" for a
 *   batch add. Returns BatchAddResponseSchema instead of ItemDraftResponseSchema.
 *
 * The server strips EXIF, checks type, size and dimensions, stores the
 * image(s), and tags the original (or the cut-out, if an older client sent
 * one). Counts one item_ingest.
 */
export const PhotoUploadFieldsSchema = z.object({
  sourceUrl: SourceUrlSchema.optional(),
  saveForReview: z.stringbool().default(false),
});

/**
 * PUT /api/items/[id]/cutout (multipart): store the cut-out the phone made
 * the first time a collage needed this item. File `cutout` (required):
 * PNG with transparency, ≤ 1600 px, ≤ MAX_CUTOUT_BYTES, no wider or taller
 * than the item's original; the same checks as the old add-time cut-out.
 * Replaces any cut-out the item already has (two phones can race). No AI,
 * not counted against any cap. Returns ItemResponseSchema.
 */
export const CUTOUT_UPLOAD_FIELDS = { cutout: UPLOAD_FIELDS.cutout } as const;

/**
 * PUT /api/items/[id]/photo (multipart): give an item a real photo, for an
 * email item saved without one (needsPhoto). File `original` (required),
 * checked like add-by-photo's. Replaces the original, removes any cut-out,
 * and clears needsPhoto. The tags stay as they are (the item is marked "to
 * review" so the user can check them against the photo). No AI, not
 * counted. Returns ItemResponseSchema.
 */
export const PHOTO_REPLACE_FIELDS = { original: UPLOAD_FIELDS.original } as const;

/** POST /api/items/link, step 1 of 2: read the product page. */
export const LinkImportRequestSchema = z.object({ url: SourceUrlSchema });
export type LinkImportRequest = z.infer<typeof LinkImportRequestSchema>;

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

/** How long the step-1 image URL lasts: long enough to show it while step 2 runs. */
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
 * link_imports table. The client calls step 2 straight away (no cut-out
 * needed since milestone 5). `product` is for display only: step 2 uses
 * the server's own copy.
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
 * POST /api/items/link/cutout (multipart), step 2 of 2: tag the item. (The
 * path keeps its old name; since milestone 5 no cut-out is needed.) Text
 * field `meta` is JSON matching this schema. The server looks up the
 * source URL and product data it stored in step 1; anything else the
 * client sends is ignored. File `cutout` is optional and DEPRECATED, as
 * for add-by-photo: leave it out, and the server tags the original.
 *
 * Single use: each import can be tagged once. A second call, an expired
 * import, or someone else's key gets not_found. Counts one item_ingest
 * against the daily cap. Returns ItemDraftResponseSchema, or
 * BatchAddResponseSchema when `saveForReview` is true.
 */
export const LinkCutoutMetaSchema = z.object({
  /** From step 1; identifies the import. */
  originalImageKey: ImageKeySchema,
  /** True for a batch add (several links): save as "to review" instead of returning a draft. Missing means false. */
  saveForReview: z.boolean().optional(),
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

/**
 * GET/PATCH /api/outfits/[id], POST /api/outfits/[id]/shop-search and
 * PUT /api/outfits/[id]/gaps/[category].
 */
export const OutfitResponseSchema = z.object({ outfit: OutfitSchema });
export type OutfitResponse = z.infer<typeof OutfitResponseSchema>;

/**
 * POST /api/outfits/[id]/shop-search: "Find in my shops". No body. Runs one
 * grounded web search for all the outfit's gaps, limited to the user's
 * favourite shops; keeps only links on those shops' websites; fetches each
 * through the add-by-link fetcher to confirm it and read its title, price
 * and image; and stores up to SHOP_PRODUCTS_PER_GAP products per gap on the
 * outfit (`gaps[].shopResults`, `gaps[].searchedAt`), replacing earlier
 * results. A chosen product (`shopProduct`) is kept.
 *
 * Returns OutfitResponseSchema. `bad_request` if the outfit has no gaps.
 * Counts one shop_search (cap shop_searches_per_day) and is refused while
 * AI is paused.
 */
export const ShopSearchResponseSchema = OutfitResponseSchema;

/** Route params of PUT /api/outfits/[id]/gaps/[category]. */
export const GapParamsSchema = z.object({ id: IdSchema, category: CategorySchema });

/**
 * PUT /api/outfits/[id]/gaps/[category]: pick a product for the gap in that
 * slot, or clear the pick. `productUrl` must be one of that gap's
 * shopResults (the server copies the product from there; nothing the
 * phone sends about the product is trusted). Returns OutfitResponseSchema;
 * `not_found` if the outfit has no gap in that category, `bad_request` if
 * the URL isn't one of its results.
 */
export const ChooseGapProductRequestSchema = z.object({ productUrl: SourceUrlSchema.nullable() });
export type ChooseGapProductRequest = z.infer<typeof ChooseGapProductRequestSchema>;

// ---------------------------------------------------------------------------
// Settings: favourite shops and the forwarding address
// ---------------------------------------------------------------------------

/**
 * GET /api/settings, and the response of PUT /api/settings and
 * POST /api/settings/forwarding-address.
 */
export const UserSettingsSchema = z.object({
  /** The shops "Find in my shops" searches, from SHOPS. New users get DEFAULT_FAVOURITE_SHOP_IDS. */
  favouriteShopIds: FavouriteShopIdsSchema,
  /**
   * The user's private forwarding address for order emails, or null when
   * the app has no inbound email domain configured yet (INBOUND_EMAIL_DOMAIN):
   * the UI then says email import isn't set up.
   */
  forwardingAddress: z.email().nullable(),
});
export type UserSettings = z.infer<typeof UserSettingsSchema>;

/** PUT /api/settings: change the favourite shops. */
export const UpdateSettingsRequestSchema = z.object({ favouriteShopIds: FavouriteShopIdsSchema });
export type UpdateSettingsRequest = z.infer<typeof UpdateSettingsRequestSchema>;

/**
 * POST /api/settings/forwarding-address: reset the forwarding address (a
 * new random token). No body. The old address stops working at once.
 * Returns UserSettingsSchema.
 */
export const ResetForwardingAddressResponseSchema = UserSettingsSchema;

// ---------------------------------------------------------------------------
// Order emails
// ---------------------------------------------------------------------------

/** GET /api/email-imports returns at most this many, newest first. */
export const EMAIL_IMPORT_LIST_LIMIT = 20;

/** GET /api/email-imports: the user's recently forwarded emails and what came of them. */
export const EmailImportListResponseSchema = z.object({ imports: z.array(EmailImportSchema).max(EMAIL_IMPORT_LIST_LIMIT) });
export type EmailImportListResponse = z.infer<typeof EmailImportListResponseSchema>;

/**
 * POST /api/inbound/email: the inbound email service's webhook. Not a
 * signed-in route. The body is the provider's own format; an adapter
 * checks the provider's signature (INBOUND_EMAIL_WEBHOOK_SECRET) over the
 * raw body before parsing it into InboundEmailSchema. See CONTRACTS.md.
 * Returns InboundWebhookResponseSchema.
 */
export const InboundEmailWebhookResponseSchema = InboundWebhookResponseSchema;

// ---------------------------------------------------------------------------
// Scheduled jobs
// ---------------------------------------------------------------------------

const CountSchema = z.int().min(0);

/**
 * GET /api/cron/cleanup (daily, from Vercel Cron, with
 * `Authorization: Bearer ${CRON_SECRET}`). Counts only: no keys, emails
 * or other user data.
 */
export const CronCleanupResponseSchema = z.object({
  /** Stored images over a day old checked for use. */
  imagesChecked: CountSchema,
  /** Of those, images no item or open link import uses, now deleted. */
  orphanedImagesDeleted: CountSchema,
  /** link_imports rows over 7 days old, deleted. */
  linkImportsDeleted: CountSchema,
  /** sign_in_attempts rows over a day old, deleted. */
  signInAttemptsDeleted: CountSchema,
});
export type CronCleanupResponse = z.infer<typeof CronCleanupResponseSchema>;
