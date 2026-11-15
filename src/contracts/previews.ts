/**
 * Generated outfit previews ("wearing it" images, spec: "Generated outfit
 * preview"), added in milestone 5 round 2.
 *
 * - The model presets: the fixed figures a user picks from in settings.
 * - The preview as the API shows it on each outfit.
 * - The cache key that makes an identical look reuse one stored image.
 * - The checks a generated image must pass before it's stored.
 *
 * docs/CONTRACTS.md, section 12, says the same in plain language.
 */
import { z } from "zod";
import { CategorySchema, ImageUrlSchema, type Category } from "./item";

// ---------------------------------------------------------------------------
// Model presets
// ---------------------------------------------------------------------------

export const MODEL_GENDERS = ["women", "men"] as const;
export const ModelGenderSchema = z.enum(MODEL_GENDERS);
export type ModelGender = z.infer<typeof ModelGenderSchema>;

/**
 * Builds. "curvy" is offered on the women's figures and "broad" on the
 * men's, in the same place in the grid (the spec's "curvy or broad").
 */
export const MODEL_BUILDS = ["slim", "average", "curvy", "broad", "plus"] as const;
export const ModelBuildSchema = z.enum(MODEL_BUILDS);
export type ModelBuild = z.infer<typeof ModelBuildSchema>;

export const BUILDS_BY_GENDER: Readonly<Record<ModelGender, readonly ModelBuild[]>> = {
  women: ["slim", "average", "curvy", "plus"],
  men: ["slim", "average", "broad", "plus"],
};

export const SKIN_TONES = ["light", "medium", "deep"] as const;
export const SkinToneSchema = z.enum(SKIN_TONES);
export type SkinTone = z.infer<typeof SkinToneSchema>;

const GENDER_LABELS: Record<ModelGender, string> = { women: "Women's", men: "Men's" };
const BUILD_LABELS: Record<ModelBuild, string> = { slim: "slim", average: "average", curvy: "curvy", broad: "broad", plus: "plus size" };
const TONE_LABELS: Record<SkinTone, string> = { light: "light", medium: "medium", deep: "deep" };

export interface ModelPreset {
  /** e.g. "women_average_medium". Stored in user_settings.model_preset_id. */
  id: string;
  /** e.g. "Women's, average build, medium skin tone". Also how the image model is told who it's dressing. */
  label: string;
  gender: ModelGender;
  build: ModelBuild;
  skinTone: SkinTone;
  /** Public path of the preset picture, served from public/presets. */
  imagePath: string;
}

function preset(gender: ModelGender, build: ModelBuild, skinTone: SkinTone): ModelPreset {
  const id = `${gender}_${build}_${skinTone}`;
  return {
    id,
    label: `${GENDER_LABELS[gender]}, ${BUILD_LABELS[build]} build, ${TONE_LABELS[skinTone]} skin tone`,
    gender,
    build,
    skinTone,
    imagePath: `/presets/${id}.webp`,
  };
}

/**
 * 2 figures × 4 builds × 3 skin tones = 24 presets, in grid order (gender,
 * then build, then tone). Adding one needs a migration too: the
 * user_settings check constraint lists the IDs (supabase/schema-vocab.test.ts
 * checks they agree).
 */
export const MODEL_PRESETS: readonly ModelPreset[] = MODEL_GENDERS.flatMap((gender) =>
  BUILDS_BY_GENDER[gender].flatMap((build) => SKIN_TONES.map((tone) => preset(gender, build, tone))),
);

export const MODEL_PRESET_IDS = MODEL_PRESETS.map((p) => p.id) as [string, ...string[]];
export const ModelPresetIdSchema = z.enum(MODEL_PRESET_IDS);
export type ModelPresetId = z.infer<typeof ModelPresetIdSchema>;

/**
 * A preset ID as stored or returned (the settings row, GET /api/settings).
 * An ID that isn't on MODEL_PRESETS any more (a preset removed or renamed
 * later, or a bad row) reads as null, "not picked yet", so the user is
 * asked again rather than the whole settings read failing. Missing also
 * reads as null. Requests that SET a preset still use the strict
 * ModelPresetIdSchema.
 */
export const StoredModelPresetIdSchema = ModelPresetIdSchema.nullable().catch(null);

export const MODEL_PRESETS_BY_ID: ReadonlyMap<string, ModelPreset> = new Map(MODEL_PRESETS.map((p) => [p.id, p]));

/**
 * Preselected in the "Pick your model" prompt. The server never applies it
 * on its own: a user with no preset is asked (bad_request on the preview
 * route), and closing the prompt saves this one.
 */
export const DEFAULT_MODEL_PRESET_ID: ModelPresetId = "women_average_medium";

/**
 * True while public/presets holds the neutral placeholder silhouettes
 * (scripts/make-preview-placeholders.mjs). The orchestrator replaces them
 * with the real generated set (PROGRESS.md task P5) and sets this false.
 * The preview route may still run against placeholders in development.
 */
export const MODEL_PRESET_IMAGES_ARE_PLACEHOLDERS = true;

// ---------------------------------------------------------------------------
// The preview on an outfit
// ---------------------------------------------------------------------------

/**
 * - none: no preview yet (the client calls POST /api/outfits/[id]/preview).
 * - pending: being generated (by this or another request for the same look).
 * - ready: stored; `imageUrl` is a short-lived signed URL.
 * - failed: generation failed twice. The collage shows. Final for this look
 *   when the model refused (blocked) or its image failed the checks
 *   (invalid_image); after ai_failed or internal (passing troubles) a later
 *   call tries again once PREVIEW_FAILED_RETRY_SECONDS have passed.
 * - skipped: not generated because of the daily cap or the spend pause; a
 *   later POST tries again. The collage shows.
 */
export const PREVIEW_STATUSES = ["none", "pending", "ready", "failed", "skipped"] as const;
export const PreviewStatusSchema = z.enum(PREVIEW_STATUSES);
export type PreviewStatus = z.infer<typeof PreviewStatusSchema>;

/** Why a preview is `failed` (final) or `skipped` (tried again on a later POST). */
export const PREVIEW_FAILED_REASONS = [
  "ai_failed", // the model errored or returned no image, twice
  "blocked", // the model refused (safety block), twice
  "invalid_image", // the image failed the output checks twice (type, size, decode, aspect ratio)
  "internal", // our side: storing it failed, or a ready image can't be found
] as const;
export const PREVIEW_SKIPPED_REASONS = ["daily_cap_reached", "ai_paused"] as const;
export const PREVIEW_FAILURE_REASONS = [...PREVIEW_FAILED_REASONS, ...PREVIEW_SKIPPED_REASONS] as const;
/** Failed reasons that are tried again after PREVIEW_FAILED_RETRY_SECONDS; the others are final for the look. */
export const PREVIEW_RETRYABLE_FAILED_REASONS = ["ai_failed", "internal"] as const;
export const PreviewFailureReasonSchema = z.enum(PREVIEW_FAILURE_REASONS);
export type PreviewFailureReason = z.infer<typeof PreviewFailureReasonSchema>;

/** The preview as it appears on every Outfit in the API (`outfit.preview`). */
export const OutfitPreviewSchema = z
  .object({
    status: PreviewStatusSchema,
    /** Signed URL (SIGNED_URL_TTL_SECONDS) when ready, otherwise null. */
    imageUrl: ImageUrlSchema.nullable(),
    /** Set for failed and skipped, otherwise null. */
    failureReason: PreviewFailureReasonSchema.nullable(),
    /** The preset the image was (or is being) made on; null for none. A preset change doesn't touch it. */
    presetId: ModelPresetIdSchema.nullable(),
    /**
     * Slots the image shows as suggested pieces (the outfit's gaps when it
     * was generated), so the UI can label them ("Trainers suggested").
     * Empty for none.
     */
    suggestedSlots: z.array(CategorySchema).max(3),
    /**
     * True when the user picked or cleared a shop product for a gap after
     * this preview was made. The image stays; "Update preview" calls
     * POST /api/outfits/[id]/preview?refresh=true.
     */
    outdated: z.boolean(),
    /**
     * True while "Update preview" is making the new picture: `imageUrl`
     * still shows the old (outdated) one until the new one is ready. Ends
     * when it's ready (the picture switches, outdated clears) or fails or
     * is skipped (the old picture stays, still outdated). Missing reads as false.
     */
    refreshing: z.boolean().default(false),
  })
  .refine((p) => (p.status === "ready") === (p.imageUrl !== null), { path: ["imageUrl"], error: "An image URL comes with a ready preview only" })
  .refine(
    (p) =>
      p.status === "failed"
        ? (PREVIEW_FAILED_REASONS as readonly string[]).includes(p.failureReason ?? "")
        : p.status === "skipped"
          ? (PREVIEW_SKIPPED_REASONS as readonly string[]).includes(p.failureReason ?? "")
          : p.failureReason === null,
    { path: ["failureReason"], error: "The reason doesn't match the status" },
  );
export type OutfitPreview = z.infer<typeof OutfitPreviewSchema>;

/** An outfit with no preview yet. Also what outfits saved before round 2 read as. */
export const NO_PREVIEW: OutfitPreview = {
  status: "none",
  imageUrl: null,
  failureReason: null,
  presetId: null,
  suggestedSlots: [],
  outdated: false,
  refreshing: false,
};

/** Query string of POST /api/outfits/[id]/preview. `?refresh=true` is "Update preview" on an outdated one. */
export const PreviewRequestQuerySchema = z.object({ refresh: z.stringbool().default(false) });
export type PreviewRequestQuery = z.infer<typeof PreviewRequestQuerySchema>;

/**
 * The bad_request issue path that means "no model preset picked yet": the
 * UI shows "Pick your model" (default preselected), saves the choice with
 * PUT /api/settings, then calls the preview route again.
 */
export const PREVIEW_NEEDS_PRESET_ISSUE_PATH = "modelPresetId";

/**
 * A pending preview older than this is taken to be abandoned (the request
 * making it died) and may be claimed again. Longer than the route's
 * maxDuration (90 s).
 */
export const PREVIEW_PENDING_STALE_SECONDS = 150;

/** A preview that failed with ai_failed or internal is tried again by a later call after this long (orchestrator decision a). */
export const PREVIEW_FAILED_RETRY_SECONDS = 60 * 60;

/** The daily cleanup deletes outfit_previews rows no outfit shows or waits for, once unchanged for this long. */
export const PREVIEW_UNUSED_SWEEP_SECONDS = 60 * 60;

/**
 * While a preview is pending (or refreshing), the client asks again at most
 * this often, with the same POST (idempotent; it also takes over an
 * abandoned generation once it's stale).
 */
export const PREVIEW_POLL_INTERVAL_MS = 3000;

// ---------------------------------------------------------------------------
// Cache key: one image per identical look
// ---------------------------------------------------------------------------

/** What makes two looks identical. Bump the version when this list changes. */
export interface PreviewLook {
  presetId: string;
  itemIds: readonly string[];
  gaps: readonly {
    category: Category;
    subcategory: string | null;
    colours: readonly string[];
    description: string;
    /** The picked shop product, if any: a different product is a different look. */
    shopProduct?: { url: string } | null;
  }[];
}

export const PREVIEW_CACHE_KEY_VERSION = 1;

/**
 * The canonical text the cache key hashes: preset, sorted owned item IDs,
 * and the gaps sorted by slot with their subcategory, colours (in order:
 * the first is the main one), description and picked product URL.
 */
export function previewCacheKeySource(look: PreviewLook): string {
  return JSON.stringify({
    v: PREVIEW_CACHE_KEY_VERSION,
    preset: look.presetId,
    items: [...look.itemIds].sort(),
    gaps: [...look.gaps]
      .sort((a, b) => a.category.localeCompare(b.category))
      .map((g) => ({
        category: g.category,
        subcategory: g.subcategory,
        colours: [...g.colours],
        description: g.description,
        product: g.shopProduct?.url ?? null,
      })),
  });
}

/** SHA-256 (lower-case hex) of previewCacheKeySource. Web Crypto, so it runs on the server and in tests alike. */
export async function previewCacheKey(look: PreviewLook): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(previewCacheKeySource(look)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const PreviewCacheKeySchema = z.string().regex(/^[0-9a-f]{64}$/);

// ---------------------------------------------------------------------------
// Checks on the generated image (code, not Zod on the bytes)
// ---------------------------------------------------------------------------

/** Types the image model may return. The caller sniffs the real type from the bytes. */
export const PREVIEW_OUTPUT_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
/** Largest reply accepted from the model, before re-encoding. */
export const PREVIEW_OUTPUT_MAX_BYTES = 8 * 1024 * 1024;
/** Shortest and longest side accepted from the model, in pixels. */
export const PREVIEW_OUTPUT_MIN_SIDE_PX = 512;
export const PREVIEW_OUTPUT_MAX_SIDE_PX = 4096;
/** Full-length portrait, asked for as 2:3 (width:height). */
export const PREVIEW_ASPECT_RATIO = { width: 2, height: 3 } as const;
/**
 * Accepted width/height ratio either side of 2/3 (0.617 to 0.717). Inside
 * it, the server may pad the image to exactly 2:3 (plain background) when
 * storing it, so every stored preview has the same shape.
 */
export const PREVIEW_ASPECT_TOLERANCE = 0.05;
/**
 * The decode for the checks is a full one (every pixel, e.g. sharp's
 * raw().toBuffer()), with at most this many input pixels and failing on
 * any decoding error (sharp `failOn: "error"`), not a header read: a
 * truncated or hostile file must fail here, not later.
 */
export const PREVIEW_DECODE_MAX_INPUT_PIXELS = 4096 * 4096;

/** What is stored: WebP, EXIF stripped, longest side at most this, at most this many bytes. */
export const PREVIEW_STORED_IMAGE_TYPE = "image/webp" as const;
export const PREVIEW_STORED_MAX_SIDE_PX = 1536;
export const PREVIEW_STORED_MAX_BYTES = 1.5 * 1024 * 1024;

export interface GeneratedImageFacts {
  /** The type sniffed from the bytes (not what the provider declared), or null if unrecognised. */
  mimeType: string | null;
  byteLength: number;
  /**
   * Pixel size from a FULL decode of the bytes (see
   * PREVIEW_DECODE_MAX_INPUT_PIXELS; inspectGeneratedImage in
   * src/lib/images/preview-check.ts does it); null if it didn't decode.
   */
  dimensions: { width: number; height: number } | null;
}

export type GeneratedImageCheck = { ok: true } | { ok: false; problem: string };

/**
 * Whether a generated image may be stored. A failure counts as an invalid
 * reply: retried once, then the preview fails with `invalid_image`.
 */
export function checkGeneratedPreviewImage(facts: GeneratedImageFacts): GeneratedImageCheck {
  if (!Number.isFinite(facts.byteLength) || facts.byteLength < 0) return { ok: false, problem: "Bad byte length" };
  if (facts.byteLength === 0) return { ok: false, problem: "No image data" };
  if (facts.byteLength > PREVIEW_OUTPUT_MAX_BYTES) return { ok: false, problem: `Image over ${PREVIEW_OUTPUT_MAX_BYTES} bytes` };
  if (!facts.mimeType || !(PREVIEW_OUTPUT_IMAGE_TYPES as readonly string[]).includes(facts.mimeType)) {
    return { ok: false, problem: `Unexpected image type ${facts.mimeType ?? "unknown"}` };
  }
  if (!facts.dimensions) return { ok: false, problem: "The image doesn't decode" };
  const { width, height } = facts.dimensions;
  if (!(width > 0 && height > 0)) return { ok: false, problem: "The image has no pixels" };
  if (Math.min(width, height) < PREVIEW_OUTPUT_MIN_SIDE_PX) return { ok: false, problem: `Image smaller than ${PREVIEW_OUTPUT_MIN_SIDE_PX} px` };
  if (Math.max(width, height) > PREVIEW_OUTPUT_MAX_SIDE_PX) return { ok: false, problem: `Image larger than ${PREVIEW_OUTPUT_MAX_SIDE_PX} px` };
  const expected = PREVIEW_ASPECT_RATIO.width / PREVIEW_ASPECT_RATIO.height;
  if (Math.abs(width / height - expected) > PREVIEW_ASPECT_TOLERANCE) {
    return { ok: false, problem: `Aspect ratio ${width}x${height} isn't a full-length ${PREVIEW_ASPECT_RATIO.width}:${PREVIEW_ASPECT_RATIO.height} portrait` };
  }
  return { ok: true };
}
