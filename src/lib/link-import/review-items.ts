/**
 * Saving an item straight away as "to review" (needs_review = true): a
 * batch add by link (step 2 with `saveForReview`) and every line of an
 * order email (CONTRACTS.md section 5). The user confirms or corrects the
 * tags later from the review list.
 *
 * Kept apart from the ingestion ItemRepository (whose `create` saves a
 * draft the user has already reviewed) so the two can change separately.
 * The Supabase version takes whichever client the caller has: the
 * signed-in user's (link step 2, RLS applies) or the admin client (the
 * email webhook, which has no session; the database still checks the
 * image keys sit in the owner's folder).
 */
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ItemRowSchema, type ItemRow, type ItemTags } from "@/contracts";
import { tagsToItemColumns } from "@/lib/db/mappers";
import { DuplicateImageKeyError, type InMemoryItemRepository } from "@/lib/ingestion/items-repository";

export interface NewReviewItem {
  source: "link" | "email";
  sourceUrl: string | null;
  originalImageKey: string;
  cutoutImageKey: string | null;
  tags: ItemTags;
  /** An email line without a usable picture: the original is a placeholder. */
  needsPhoto: boolean;
}

export interface ReviewItemStore {
  /** Insert the item with needs_review = true and tags_edited = false. */
  create(userId: string, item: NewReviewItem): Promise<ItemRow>;
}

const COLUMNS =
  "id, user_id, source, source_url, original_image_key, cutout_image_key, category, subcategory, colours, pattern, formality, seasons, warmth, occasions, fabric, description, tags_edited, needs_review, needs_photo, created_at";

function toColumns(userId: string, item: NewReviewItem) {
  return {
    user_id: userId,
    source: item.source,
    source_url: item.sourceUrl,
    original_image_key: item.originalImageKey,
    cutout_image_key: item.cutoutImageKey,
    ...tagsToItemColumns(item.tags),
    tags_edited: false,
    needs_review: true,
    needs_photo: item.needsPhoto,
  };
}

export class SupabaseReviewItemStore implements ReviewItemStore {
  constructor(private readonly db: SupabaseClient) {}

  async create(userId: string, item: NewReviewItem): Promise<ItemRow> {
    const { data, error } = await this.db.from("items").insert(toColumns(userId, item)).select(COLUMNS).single();
    // Postgres unique_violation: the image is already another item's.
    if (error?.code === "23505") throw new DuplicateImageKeyError();
    if (error) throw new Error(`Couldn't save the item: ${error.message}`);
    return ItemRowSchema.parse(data);
  }
}

/** For tests: writes into an InMemoryItemRepository, so the wardrobe routes see the items. */
export class InMemoryReviewItemStore implements ReviewItemStore {
  constructor(
    private readonly items: InMemoryItemRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async create(userId: string, item: NewReviewItem): Promise<ItemRow> {
    const keys = [item.originalImageKey, item.cutoutImageKey].filter((key): key is string => key !== null);
    for (const row of this.items.rows.values()) {
      if (keys.some((key) => key === row.original_image_key || key === row.cutout_image_key)) throw new DuplicateImageKeyError();
    }
    if (!keys.every((key) => key.startsWith(`${userId}/`))) throw new Error("Couldn't save the item: image not in owner folder");
    const row = ItemRowSchema.parse({
      id: crypto.randomUUID(),
      created_at: new Date(this.now().getTime() + this.items.rows.size).toISOString(),
      ...toColumns(userId, item),
    });
    this.items.rows.set(row.id, row);
    return structuredClone(row);
  }
}
