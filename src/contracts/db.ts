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
import { FeedbackKindSchema } from "./feedback";
import { OutfitStatusSchema, StoredOutfitRequestSchema } from "./outfit";
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
