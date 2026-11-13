/**
 * Row shapes for the Postgres tables in supabase/migrations, in the
 * database's snake_case. Use these to type and check what Supabase returns;
 * map to the camelCase API shapes with src/lib/db/mappers.ts.
 */
import { z } from "zod";
import { IdSchema } from "./common";
import {
  CategorySchema,
  ColourSchema,
  FormalitySchema,
  ImageKeySchema,
  ItemSourceSchema,
  PatternSchema,
  SeasonSchema,
  SubcategorySchema,
  WarmthSchema,
} from "./item";
import { LinkProductSchema } from "./api";
import { FeedbackKindSchema } from "./feedback";
import { OutfitGapsSchema, OutfitStatusSchema, StoredOutfitRequestSchema } from "./outfit";
import { FavouriteShopIdsSchema } from "./shops";
import { ModelPresetIdSchema, PREVIEW_FAILURE_REASONS, PreviewCacheKeySchema } from "./previews";
import { EmailImportErrorSchema, EmailImportStatusSchema, ForwardingTokenSchema } from "./email";
import { PresetStyleIdSchema } from "./styles";
import { UsageEventKindSchema } from "./usage";

/** Postgres returns timestamptz like "2026-10-21 09:00:00+00" or ISO; accept any non-empty string. */
const DbTimestampSchema = z.string().min(1);

export const UserRowSchema = z.object({
  id: IdSchema,
  email: z.string(),
  display_name: z.string().nullable(),
  created_at: DbTimestampSchema,
});
export type UserRow = z.infer<typeof UserRowSchema>;

export const ItemRowSchema = z.object({
  id: IdSchema,
  user_id: IdSchema,
  source: ItemSourceSchema,
  source_url: z.string().nullable(),
  original_image_key: ImageKeySchema,
  cutout_image_key: ImageKeySchema.nullable(),
  category: CategorySchema,
  subcategory: SubcategorySchema,
  colours: z.array(ColourSchema),
  pattern: PatternSchema,
  formality: FormalitySchema,
  seasons: z.array(SeasonSchema),
  warmth: WarmthSchema,
  occasions: z.array(PresetStyleIdSchema),
  fabric: z.string().nullable(),
  description: z.string(),
  tags_edited: z.boolean(),
  /** Added in milestone 5. Defaults keep rows read with an older column list valid. */
  needs_review: z.boolean().default(false),
  needs_photo: z.boolean().default(false),
  created_at: DbTimestampSchema,
});
export type ItemRow = z.infer<typeof ItemRowSchema>;

export const OutfitRowSchema = z.object({
  id: IdSchema,
  user_id: IdSchema,
  request: StoredOutfitRequestSchema,
  name: z.string(),
  reason: z.string(),
  item_ids: z.array(IdSchema),
  /** Added in milestone 5 (jsonb, default []). */
  gaps: OutfitGapsSchema.default([]),
  status: OutfitStatusSchema,
  parent_outfit_id: IdSchema.nullable(),
  created_at: DbTimestampSchema,
  /**
   * Round 2: the outfit_previews row whose image this outfit shows; null
   * for no preview yet. Several outfits can share one (an identical look).
   * Written by the server only.
   */
  preview_id: IdSchema.nullable().default(null),
  /** Round 2: a refresh in progress: the new look's preview, while preview_id still shows the old picture. */
  pending_preview_id: IdSchema.nullable().default(null),
  /** Round 2: set by the database when a gap's chosen product changes after the preview was linked. */
  preview_outdated: z.boolean().default(false),
});
export type OutfitRow = z.infer<typeof OutfitRowSchema>;

/**
 * Round 2: one generated preview image, shared by every outfit of the same
 * user with the same look (cache_key). Server writes; users read their own.
 */
export const OutfitPreviewRowSchema = z.object({
  id: IdSchema,
  user_id: IdSchema,
  cache_key: PreviewCacheKeySchema,
  preset_id: ModelPresetIdSchema,
  /** The owned items the image shows: deleting one, or replacing its photo, deletes this row. */
  item_ids: z.array(IdSchema).min(1).max(4),
  /** The gap slots the image shows as suggested pieces. */
  suggested_slots: z.array(CategorySchema),
  status: z.enum(["pending", "ready", "failed", "skipped"]),
  /** In the previews bucket, `<user id>/<uuid>.webp`; set when ready. */
  image_key: z.string().nullable(),
  failure_reason: z.enum(PREVIEW_FAILURE_REASONS).nullable(),
  /** When generation was last claimed (stale pending and the failed-retry window count from it). */
  attempted_at: DbTimestampSchema,
  created_at: DbTimestampSchema,
  updated_at: DbTimestampSchema,
});
export type OutfitPreviewRow = z.infer<typeof OutfitPreviewRowSchema>;

/** What public.claim_outfit_preview returns (migration 8). */
export const ClaimOutfitPreviewResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(false), reason: z.literal("not_found") }),
  z.object({
    ok: z.literal(true),
    /**
     * - existing: what the outfit shows stands (ready, failed for good or
     *   recently, or pending in another request); nothing to do. On the
     *   look the picture shows, this also clears "outdated".
     * - reused: linked to the same look's ready (or standing failed) preview; no cost, no cap.
     * - wait: linked to the same look's preview, pending in another request.
     * - generate: this request must generate it (the row is pending and
     *   claimed); then call finish_outfit_preview.
     * - unavailable: a refresh onto a look that failed within the retry
     *   window; the outfit keeps its outdated picture.
     */
    action: z.enum(["existing", "reused", "wait", "generate", "unavailable"]),
    preview_id: IdSchema,
    status: z.enum(["pending", "ready", "failed", "skipped"]),
    /** True when the preview is a refresh's (outfits.pending_preview_id): the old picture still shows. */
    refreshing: z.boolean(),
    /**
     * The image of a preview this outfit stopped using, when no other
     * outfit uses it any more (its row is deleted): remove it from storage.
     */
    released_image_key: z.string().nullable(),
  }),
]);
export type ClaimOutfitPreviewResult = z.infer<typeof ClaimOutfitPreviewResultSchema>;

/**
 * What public.finish_outfit_preview returns. ok false: the row is gone (an
 * item it shows was deleted or got a new photo) or isn't pending any more;
 * delete the image just made. released_image_keys: old pictures of outfits
 * that switched to this one and that nothing uses any more; remove them.
 */
export const FinishOutfitPreviewResultSchema = z.object({
  ok: z.boolean(),
  released_image_keys: z.array(z.string()),
});
export type FinishOutfitPreviewResult = z.infer<typeof FinishOutfitPreviewResultSchema>;

/** What public.sweep_unused_outfit_previews returns (the daily cleanup). */
export const SweepUnusedPreviewsResultSchema = z.object({
  deleted: z.int().min(0),
  image_keys: z.array(z.string()),
});
export type SweepUnusedPreviewsResult = z.infer<typeof SweepUnusedPreviewsResultSchema>;

export const OutfitFeedbackRowSchema = z.object({
  id: IdSchema,
  outfit_id: IdSchema,
  user_id: IdSchema,
  kind: FeedbackKindSchema,
  detail: z.string().nullable(),
  created_at: DbTimestampSchema,
});
export type OutfitFeedbackRow = z.infer<typeof OutfitFeedbackRowSchema>;

/** Add-by-link step 1, waiting for step 2. Server only. */
export const LinkImportRowSchema = z.object({
  id: IdSchema,
  user_id: IdSchema,
  source_url: z.string(),
  original_image_key: ImageKeySchema,
  product: LinkProductSchema,
  created_at: DbTimestampSchema,
  tagged_at: DbTimestampSchema.nullable(),
});
export type LinkImportRow = z.infer<typeof LinkImportRowSchema>;

export const UsageEventRowSchema = z.object({
  id: IdSchema,
  user_id: IdSchema.nullable(),
  kind: UsageEventKindSchema,
  /** Estimated cost in pence (fractional). 0 for the counted-only kinds. */
  cost_pence: z.coerce.number().min(0),
  provider: z.string().nullable(),
  created_at: DbTimestampSchema,
});
export type UsageEventRow = z.infer<typeof UsageEventRowSchema>;

/**
 * One row per user (created with the profile): favourite shops and the
 * forwarding token. Users can read their own row and change only
 * favourite_shop_ids; the token is reset through reset_forwarding_token().
 */
export const UserSettingsRowSchema = z.object({
  user_id: IdSchema,
  favourite_shop_ids: FavouriteShopIdsSchema,
  forwarding_token: ForwardingTokenSchema,
  /** Round 2: the model figure previews are made on; null until the user picks one. */
  model_preset_id: ModelPresetIdSchema.nullable().default(null),
  updated_at: DbTimestampSchema,
});
export type UserSettingsRow = z.infer<typeof UserSettingsRowSchema>;

/** One forwarded email and what came of it. Never holds the email itself. */
export const EmailImportRowSchema = z.object({
  id: IdSchema,
  user_id: IdSchema,
  /** SHA-256 (hex) of the provider's message ID, to ignore a redelivered webhook. */
  message_hash: z.string().regex(/^[0-9a-f]{64}$/),
  received_at: DbTimestampSchema,
  shop_name: z.string().nullable(),
  /** YYYY-MM-DD */
  order_date: z.string().nullable(),
  status: EmailImportStatusSchema,
  item_count: z.int().min(0),
  skipped_count: z.int().min(0),
  error: EmailImportErrorSchema.nullable(),
  created_at: DbTimestampSchema,
});
export type EmailImportRow = z.infer<typeof EmailImportRowSchema>;
