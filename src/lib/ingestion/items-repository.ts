/**
 * Reading and writing rows in the items table. Behind an interface so the
 * wardrobe logic can be tested with the in-memory version.
 *
 * The Supabase version uses the signed-in user's client, so row-level
 * security applies on top of the explicit user_id filters.
 */
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  ItemRowSchema,
  LINK_IMPORT_TTL_SECONDS,
  type CreateItemRequest,
  type ItemListQuery,
  type ItemRow,
  type ItemSource,
  type ItemTags,
} from "@/contracts";
import { tagsToItemColumns } from "@/lib/db/mappers";

/**
 * A new item row. A reviewed draft (POST /api/items) is a CreateItemRequest
 * and is never "to review"; the server saves batch-added items with
 * needsReview, and (order emails) items without a picture with needsPhoto.
 */
export type NewItem = Omit<CreateItemRequest, "source"> & {
  source: ItemSource;
  needsReview?: boolean;
  needsPhoto?: boolean;
};

/** Columns for an items insert. */
function newItemToRow(userId: string, item: NewItem) {
  return {
    user_id: userId,
    source: item.source,
    source_url: item.sourceUrl,
    original_image_key: item.originalImageKey,
    cutout_image_key: item.cutoutImageKey,
    tags_edited: item.tagsEdited,
    ...tagsToItemColumns(item.tags),
    needs_review: item.needsReview ?? false,
    needs_photo: item.needsPhoto ?? false,
  };
}

export interface ItemRepository {
  /** The user's items, newest first, filtered as the query says. */
  list(userId: string, query: ItemListQuery): Promise<ItemRow[]>;
  get(userId: string, id: string): Promise<ItemRow | null>;
  /** Insert an item. Throws DuplicateImageKeyError if another item uses one of its images. */
  create(userId: string, item: NewItem): Promise<ItemRow>;
  /** Replace all the tags, set tags_edited and clear needs_review. Null if there's no such item. */
  updateTags(userId: string, id: string, tags: ItemTags): Promise<ItemRow | null>;
  /** Clear needs_review on one item ("the tags are right"). Null if there's no such item. */
  markReviewed(userId: string, id: string): Promise<ItemRow | null>;
  /** Clear needs_review on several items. Returns how many of the IDs were the user's items. */
  markManyReviewed(userId: string, ids: readonly string[]): Promise<number>;
  /**
   * Point the item at a new cut-out, only if its original is still
   * `madeFromOriginalKey` (the picture the cut-out was made from and
   * measured against). Null if there's no such item, or its photo has
   * changed since.
   */
  setCutoutKey(userId: string, id: string, cutoutKey: string, madeFromOriginalKey: string): Promise<ItemRow | null>;
  /**
   * Give the item a new original: drops its cut-out (cut from the old
   * picture), clears needs_photo and marks it "to review". Null if there's no such item.
   */
  replaceOriginal(userId: string, id: string, originalKey: string): Promise<ItemRow | null>;
  /** Delete and return the row (for its image keys). Null if there's no such item. */
  delete(userId: string, id: string): Promise<ItemRow | null>;
  /** Which of these image keys an existing item of this user already uses. */
  keysInUse(userId: string, keys: readonly string[]): Promise<Set<string>>;
}

/**
 * Cross-user lookups for the orphaned-image cleanup job. Needs the admin
 * (secret key) client, since it runs for every user.
 */
export interface ImageReferences {
  /** Which of these keys are still needed: used by an item, or by a recent add-by-link import. */
  referenced(keys: readonly string[]): Promise<Set<string>>;
}

const ITEM_COLUMNS =
  "id, user_id, source, source_url, original_image_key, cutout_image_key, category, subcategory, colours, pattern, formality, seasons, warmth, occasions, fabric, description, tags_edited, needs_review, needs_photo, created_at";

/**
 * Make search text safe for an ILIKE pattern: %, _ and the escape character
 * are escaped so they match literally. PostgREST also treats `*` as `%` in
 * like patterns (escaped or not), so each `*` becomes `_`, which matches
 * exactly one character: "a*b" still finds "a*b", and can't list everything.
 */
export function escapeLikePattern(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`).replace(/\*/g, "_");
}

function parseRows(data: unknown): ItemRow[] {
  return z.array(ItemRowSchema).parse(data ?? []);
}

function parseRow(data: unknown): ItemRow | null {
  return data ? ItemRowSchema.parse(data) : null;
}

/**
 * An image key is already used by another item. The database enforces
 * this with unique indexes (two saves of one draft at the same moment can
 * both pass the keysInUse check); createWardrobeItem turns it into a
 * bad_request.
 */
export class DuplicateImageKeyError extends Error {
  constructor() {
    super("An item already uses that image");
    this.name = "DuplicateImageKeyError";
  }
}

/** Postgres unique_violation. */
const UNIQUE_VIOLATION = "23505";

export class SupabaseItemRepository implements ItemRepository {
  constructor(private readonly db: SupabaseClient) {}

  async list(userId: string, query: ItemListQuery): Promise<ItemRow[]> {
    let request = this.db.from("items").select(ITEM_COLUMNS).eq("user_id", userId);
    if (query.category) request = request.eq("category", query.category);
    if (query.colour) request = request.contains("colours", [query.colour]);
    if (query.occasion) request = request.contains("occasions", [query.occasion]);
    if (query.q) request = request.ilike("description", `%${escapeLikePattern(query.q)}%`);
    if (query.needsReview !== undefined) request = request.eq("needs_review", query.needsReview);
    const { data, error } = await request.order("created_at", { ascending: false });
    if (error) throw new Error(`Couldn't list items: ${error.message}`);
    return parseRows(data);
  }

  async get(userId: string, id: string): Promise<ItemRow | null> {
    const { data, error } = await this.db
      .from("items")
      .select(ITEM_COLUMNS)
      .eq("user_id", userId)
      .eq("id", id)
      .maybeSingle();
    if (error) throw new Error(`Couldn't read the item: ${error.message}`);
    return parseRow(data);
  }

  async create(userId: string, item: NewItem): Promise<ItemRow> {
    const { data, error } = await this.db
      .from("items")
      .insert(newItemToRow(userId, item))
      .select(ITEM_COLUMNS)
      .single();
    if (error?.code === UNIQUE_VIOLATION) throw new DuplicateImageKeyError();
    if (error) throw new Error(`Couldn't save the item: ${error.message}`);
    return ItemRowSchema.parse(data);
  }

  async updateTags(userId: string, id: string, tags: ItemTags): Promise<ItemRow | null> {
    return this.updateOne(userId, id, { ...tagsToItemColumns(tags), tags_edited: true, needs_review: false });
  }

  async markReviewed(userId: string, id: string): Promise<ItemRow | null> {
    return this.updateOne(userId, id, { needs_review: false });
  }

  async markManyReviewed(userId: string, ids: readonly string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const { data, error } = await this.db
      .from("items")
      .update({ needs_review: false })
      .eq("user_id", userId)
      .in("id", [...ids])
      .select("id");
    if (error) throw new Error(`Couldn't mark the items reviewed: ${error.message}`);
    return (data ?? []).length;
  }

  async setCutoutKey(userId: string, id: string, cutoutKey: string, madeFromOriginalKey: string): Promise<ItemRow | null> {
    return this.updateOne(userId, id, { cutout_image_key: cutoutKey }, { original_image_key: madeFromOriginalKey });
  }

  async replaceOriginal(userId: string, id: string, originalKey: string): Promise<ItemRow | null> {
    return this.updateOne(userId, id, {
      original_image_key: originalKey,
      cutout_image_key: null,
      needs_photo: false,
      needs_review: true,
    });
  }

  /** Update one of the user's items, optionally only while other columns still hold the given values. */
  private async updateOne(
    userId: string,
    id: string,
    columns: Record<string, unknown>,
    unlessChanged: Record<string, string> = {},
  ): Promise<ItemRow | null> {
    let request = this.db.from("items").update(columns).eq("user_id", userId).eq("id", id);
    for (const [column, value] of Object.entries(unlessChanged)) request = request.eq(column, value);
    const { data, error } = await request.select(ITEM_COLUMNS).maybeSingle();
    if (error?.code === UNIQUE_VIOLATION) throw new DuplicateImageKeyError();
    if (error) throw new Error(`Couldn't update the item: ${error.message}`);
    return parseRow(data);
  }

  async delete(userId: string, id: string): Promise<ItemRow | null> {
    const { data, error } = await this.db
      .from("items")
      .delete()
      .eq("user_id", userId)
      .eq("id", id)
      .select(ITEM_COLUMNS)
      .maybeSingle();
    if (error) throw new Error(`Couldn't delete the item: ${error.message}`);
    return parseRow(data);
  }

  async keysInUse(userId: string, keys: readonly string[]): Promise<Set<string>> {
    const inUse = new Set<string>();
    if (keys.length === 0) return inUse;
    for (const column of ["original_image_key", "cutout_image_key"] as const) {
      const { data, error } = await this.db.from("items").select(column).eq("user_id", userId).in(column, [...keys]);
      if (error) throw new Error(`Couldn't check image keys: ${error.message}`);
      for (const row of (data ?? []) as Record<string, string | null>[]) {
        const key = row[column];
        if (key) inUse.add(key);
      }
    }
    return inUse;
  }
}

/** Admin-client version of ImageReferences, for the cleanup job. */
export class SupabaseImageReferences implements ImageReferences {
  constructor(
    private readonly admin: SupabaseClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async referenced(keys: readonly string[]): Promise<Set<string>> {
    const found = new Set<string>();
    if (keys.length === 0) return found;
    const list = [...keys];
    for (const column of ["original_image_key", "cutout_image_key"] as const) {
      const { data, error } = await this.admin.from("items").select(column).in(column, list);
      if (error) throw new Error(`Couldn't check image references: ${error.message}`);
      for (const row of (data ?? []) as Record<string, string | null>[]) {
        const key = row[column];
        if (key) found.add(key);
      }
    }
    // An add-by-link import can still be finished within its time limit.
    const since = new Date(this.now().getTime() - LINK_IMPORT_TTL_SECONDS * 1000).toISOString();
    const { data, error } = await this.admin
      .from("link_imports")
      .select("original_image_key")
      .in("original_image_key", list)
      .gt("created_at", since);
    if (error) throw new Error(`Couldn't check link imports: ${error.message}`);
    for (const row of (data ?? []) as { original_image_key: string }[]) found.add(row.original_image_key);
    return found;
  }
}

// ---------------------------------------------------------------------------
// In memory (tests)
// ---------------------------------------------------------------------------

/** For tests. Also implements ImageReferences across all users. */
export class InMemoryItemRepository implements ItemRepository, ImageReferences {
  readonly rows = new Map<string, ItemRow>();
  /** Image keys of add-by-link imports that are still open. */
  readonly openLinkImportKeys = new Set<string>();
  private tick = 0;

  constructor(private readonly now: () => Date = () => new Date()) {}

  async list(userId: string, query: ItemListQuery): Promise<ItemRow[]> {
    const q = query.q?.toLowerCase();
    return [...this.rows.values()]
      .filter((row) => row.user_id === userId)
      .filter((row) => !query.category || row.category === query.category)
      .filter((row) => !query.colour || row.colours.includes(query.colour))
      .filter((row) => !query.occasion || row.occasions.includes(query.occasion))
      .filter((row) => !q || row.description.toLowerCase().includes(q))
      .filter((row) => query.needsReview === undefined || row.needs_review === query.needsReview)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map((row) => structuredClone(row));
  }

  async get(userId: string, id: string): Promise<ItemRow | null> {
    const row = this.rows.get(id);
    return row && row.user_id === userId ? structuredClone(row) : null;
  }

  /** Like the database's unique indexes on the image keys. */
  private assertKeysFree(keys: readonly (string | null)[], exceptId?: string): void {
    const wanted = keys.filter((key): key is string => key !== null);
    for (const row of this.rows.values()) {
      if (row.id === exceptId) continue;
      if (wanted.some((key) => key === row.original_image_key || key === row.cutout_image_key)) throw new DuplicateImageKeyError();
    }
  }

  async create(userId: string, item: NewItem): Promise<ItemRow> {
    this.assertKeysFree([item.originalImageKey, item.cutoutImageKey]);
    // Keep creation order stable even within one millisecond.
    const createdAt = new Date(this.now().getTime() + this.tick++).toISOString();
    const row = ItemRowSchema.parse({
      id: crypto.randomUUID(),
      created_at: createdAt,
      ...newItemToRow(userId, item),
    });
    this.rows.set(row.id, row);
    return structuredClone(row);
  }

  async updateTags(userId: string, id: string, tags: ItemTags): Promise<ItemRow | null> {
    const row = this.rows.get(id);
    if (!row || row.user_id !== userId) return null;
    Object.assign(row, tagsToItemColumns(tags), { tags_edited: true, needs_review: false });
    return structuredClone(row);
  }

  async markReviewed(userId: string, id: string): Promise<ItemRow | null> {
    const row = this.rows.get(id);
    if (!row || row.user_id !== userId) return null;
    row.needs_review = false;
    return structuredClone(row);
  }

  async markManyReviewed(userId: string, ids: readonly string[]): Promise<number> {
    let updated = 0;
    for (const id of new Set(ids)) {
      if (await this.markReviewed(userId, id)) updated++;
    }
    return updated;
  }

  async setCutoutKey(userId: string, id: string, cutoutKey: string, madeFromOriginalKey: string): Promise<ItemRow | null> {
    const row = this.rows.get(id);
    if (!row || row.user_id !== userId || row.original_image_key !== madeFromOriginalKey) return null;
    this.assertKeysFree([cutoutKey], id);
    row.cutout_image_key = cutoutKey;
    return structuredClone(row);
  }

  async replaceOriginal(userId: string, id: string, originalKey: string): Promise<ItemRow | null> {
    const row = this.rows.get(id);
    if (!row || row.user_id !== userId) return null;
    this.assertKeysFree([originalKey], id);
    Object.assign(row, { original_image_key: originalKey, cutout_image_key: null, needs_photo: false, needs_review: true });
    return structuredClone(row);
  }

  async delete(userId: string, id: string): Promise<ItemRow | null> {
    const row = this.rows.get(id);
    if (!row || row.user_id !== userId) return null;
    this.rows.delete(id);
    return row;
  }

  async keysInUse(userId: string, keys: readonly string[]): Promise<Set<string>> {
    const wanted = new Set(keys);
    const inUse = new Set<string>();
    for (const row of this.rows.values()) {
      if (row.user_id !== userId) continue;
      for (const key of [row.original_image_key, row.cutout_image_key]) {
        if (key && wanted.has(key)) inUse.add(key);
      }
    }
    return inUse;
  }

  async referenced(keys: readonly string[]): Promise<Set<string>> {
    const found = new Set<string>();
    for (const key of keys) {
      if (this.openLinkImportKeys.has(key)) found.add(key);
    }
    for (const row of this.rows.values()) {
      for (const key of [row.original_image_key, row.cutout_image_key]) {
        if (key && keys.includes(key)) found.add(key);
      }
    }
    return found;
  }
}
