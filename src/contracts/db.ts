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
});
export type OutfitRow = z.infer<typeof OutfitRowSchema>;

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
