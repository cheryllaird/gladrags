/**
 * OutfitRepository on Supabase. Uses the signed-in user's client, so
 * row-level security applies on top of the explicit user_id filters.
 * Rows coming back are checked against the schemas in src/contracts/db.ts.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ItemRowSchema,
  OutfitRowSchema,
  STORAGE_BUCKETS,
  type FeedbackKind,
  type ItemRow,
  type Outfit,
  type OutfitRow,
  type OutfitStatus,
  type WardrobeItem,
} from "@/contracts";
import { itemRowToWardrobeItem, outfitRowToOutfit } from "@/lib/db/mappers";
import { SIGNED_URL_TTL_SECONDS } from "@/lib/images/server";
import { OUTFIT_LIST_LIMIT, type NewOutfit, type OutfitRepository } from "./repository";
import type { WardrobeEntry } from "./types";

const ITEM_COLUMNS =
  "id, user_id, source, source_url, original_image_key, cutout_image_key, category, subcategory, colours, pattern, formality, seasons, warmth, occasions, fabric, description, tags_edited, created_at";
const OUTFIT_COLUMNS = "id, user_id, request, name, reason, item_ids, status, parent_outfit_id, created_at";

function fail(what: string, error: { message: string }): never {
  throw new Error(`Couldn't ${what}: ${error.message}`);
}

function parseRows<T>(schema: { parse: (v: unknown) => T }, rows: unknown[] | null): T[] {
  return (rows ?? []).map((row) => schema.parse(row));
}

export class SupabaseOutfitRepository implements OutfitRepository {
  constructor(private readonly client: SupabaseClient) {}

  async listWardrobe(userId: string): Promise<WardrobeEntry[]> {
    const { data, error } = await this.client.from("items").select(ITEM_COLUMNS).eq("user_id", userId);
    if (error) fail("load the wardrobe", error);
    return parseRows(ItemRowSchema, data).map((row) => {
      const item = itemRowToWardrobeItem(row, { originalUrl: "", cutoutUrl: null });
      return {
        id: row.id,
        tags: item.tags,
        image: row.cutout_image_key
          ? { bucket: STORAGE_BUCKETS.cutouts, key: row.cutout_image_key }
          : { bucket: STORAGE_BUCKETS.originals, key: row.original_image_key },
      };
    });
  }

  async listOutfits(userId: string, status?: OutfitStatus): Promise<Outfit[]> {
    let query = this.client.from("outfits").select(OUTFIT_COLUMNS).eq("user_id", userId);
    if (status) query = query.eq("status", status);
    const { data, error } = await query.order("created_at", { ascending: false }).limit(OUTFIT_LIST_LIMIT);
    if (error) fail("load outfits", error);
    return this.withItems(userId, parseRows(OutfitRowSchema, data));
  }

  async getOutfit(userId: string, outfitId: string): Promise<Outfit | null> {
    const { data, error } = await this.client
      .from("outfits")
      .select(OUTFIT_COLUMNS)
      .eq("user_id", userId)
      .eq("id", outfitId)
      .maybeSingle();
    if (error) fail("load the outfit", error);
    if (!data) return null;
    const [outfit] = await this.withItems(userId, [OutfitRowSchema.parse(data)]);
    return outfit ?? null;
  }

  async insertOutfits(userId: string, outfits: readonly NewOutfit[]): Promise<Outfit[]> {
    if (outfits.length === 0) return [];
    const { data, error } = await this.client
      .from("outfits")
      .insert(
        outfits.map((o) => ({
          user_id: userId,
          request: o.request,
          name: o.name,
          reason: o.reason,
          item_ids: o.itemIds,
          status: "suggested",
          parent_outfit_id: o.parentOutfitId,
        })),
      )
      .select(OUTFIT_COLUMNS);
    if (error) fail("save outfits", error);
    const rows = parseRows(OutfitRowSchema, data);
    // Return them in the order they were ranked, not the order the database chose.
    const order = new Map(outfits.map((o, i) => [o.itemIds.join("+"), i]));
    rows.sort((a, b) => (order.get(a.item_ids.join("+")) ?? 0) - (order.get(b.item_ids.join("+")) ?? 0));
    return this.withItems(userId, rows);
  }

  async setStatus(userId: string, outfitId: string, status: OutfitStatus): Promise<Outfit | null> {
    const { data, error } = await this.client
      .from("outfits")
      .update({ status })
      .eq("user_id", userId)
      .eq("id", outfitId)
      .select(OUTFIT_COLUMNS)
      .maybeSingle();
    if (error) fail("update the outfit", error);
    if (!data) return null;
    const [outfit] = await this.withItems(userId, [OutfitRowSchema.parse(data)]);
    return outfit ?? null;
  }

  async addFeedback(userId: string, outfitId: string, kind: FeedbackKind, detail: string | null): Promise<void> {
    const { error } = await this.client
      .from("outfit_feedback")
      .insert({ user_id: userId, outfit_id: outfitId, kind, detail });
    if (error) fail("save feedback", error);
  }

  async listRejectedItemIds(userId: string, limit: number): Promise<string[][]> {
    const { data, error } = await this.client
      .from("outfits")
      .select("item_ids")
      .eq("user_id", userId)
      .eq("status", "rejected")
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) fail("load rejected outfits", error);
    return parseRows(OutfitRowSchema.pick({ item_ids: true }), data).map((r) => r.item_ids);
  }

  /** Attach each outfit's items, with signed image URLs. */
  private async withItems(userId: string, rows: OutfitRow[]): Promise<Outfit[]> {
    const ids = [...new Set(rows.flatMap((r) => r.item_ids))];
    if (ids.length === 0) return [];
    const { data, error } = await this.client.from("items").select(ITEM_COLUMNS).eq("user_id", userId).in("id", ids);
    if (error) fail("load outfit items", error);
    const items = await this.signItems(parseRows(ItemRowSchema, data));
    const byId = new Map(items.map((i) => [i.id, i]));
    // An item deleted mid-request takes its outfits with it (database
    // trigger); skip any outfit that lost an item rather than failing.
    return rows.filter((r) => r.item_ids.every((id) => byId.has(id))).map((r) => outfitRowToOutfit(r, byId));
  }

  private async signItems(rows: ItemRow[]): Promise<WardrobeItem[]> {
    const sign = async (bucket: string, keys: string[]) => {
      if (keys.length === 0) return new Map<string, string>();
      const { data, error } = await this.client.storage.from(bucket).createSignedUrls(keys, SIGNED_URL_TTL_SECONDS);
      if (error) fail("sign image URLs", error);
      return new Map((data ?? []).flatMap((d) => (d.path && d.signedUrl ? [[d.path, d.signedUrl] as const] : [])));
    };
    const [originals, cutouts] = await Promise.all([
      sign(STORAGE_BUCKETS.originals, rows.map((r) => r.original_image_key)),
      sign(
        STORAGE_BUCKETS.cutouts,
        rows.flatMap((r) => (r.cutout_image_key ? [r.cutout_image_key] : [])),
      ),
    ]);
    return rows.map((row) => {
      const originalUrl = originals.get(row.original_image_key);
      if (!originalUrl) throw new Error(`Couldn't sign the image for item ${row.id}`);
      const cutoutUrl = row.cutout_image_key ? (cutouts.get(row.cutout_image_key) ?? null) : null;
      return itemRowToWardrobeItem(row, { originalUrl, cutoutUrl });
    });
  }
}
