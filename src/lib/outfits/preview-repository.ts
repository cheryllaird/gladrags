/**
 * Round 2: what the preview route reads and writes in the database.
 *
 * Reads (the user's preset, the outfit and its items, a preview row) use
 * the signed-in user's client, so row-level security applies too. The two
 * database functions that change previews, claim_outfit_preview and
 * finish_outfit_preview, are server only and run with the admin (secret
 * key) client; both take the user's ID and check ownership themselves.
 *
 * Deadlocks: claim and finish lock the look, the outfits and the preview
 * row in one order, but a concurrent item change can still meet them the
 * other way round. On SQLSTATE 40P01 (deadlock_detected) Postgres has
 * rolled the losing call back completely, so it's retried once.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ClaimOutfitPreviewResultSchema,
  FinishOutfitPreviewResultSchema,
  ItemRowSchema,
  OutfitPreviewRowSchema,
  OutfitRowSchema,
  PREVIEW_FAILED_RETRY_SECONDS,
  PREVIEW_PENDING_STALE_SECONDS,
  UserSettingsRowSchema,
  type ClaimOutfitPreviewResult,
  type FinishOutfitPreviewResult,
  type OutfitPreviewRow,
  type OutfitRow,
  type PreviewFailureReason,
} from "@/contracts";
import { ITEM_COLUMNS, OUTFIT_COLUMNS, PREVIEW_COLUMNS, itemRowToWardrobeEntry } from "./supabase-repository";
import type { WardrobeEntry } from "./types";

/** The outfit as the preview route needs it: its row and its items (in item_ids order). */
export interface PreviewOutfitSource {
  row: OutfitRow;
  items: WardrobeEntry[];
}

export interface ClaimPreviewArgs {
  userId: string;
  outfitId: string;
  cacheKey: string;
  presetId: string;
  refresh: boolean;
}

export type FinishPreviewArgs =
  | { userId: string; previewId: string; status: "ready"; imageKey: string }
  | { userId: string; previewId: string; status: "failed" | "skipped"; failureReason: PreviewFailureReason };

export interface PreviewRepository {
  /** user_settings.model_preset_id, or null if the user hasn't picked one. */
  getModelPresetId(userId: string): Promise<string | null>;
  /** Null when the outfit isn't the user's, or an item it uses has gone. */
  getOutfitSource(userId: string, outfitId: string): Promise<PreviewOutfitSource | null>;
  getPreview(userId: string, previewId: string): Promise<OutfitPreviewRow | null>;
  claim(args: ClaimPreviewArgs): Promise<ClaimOutfitPreviewResult>;
  finish(args: FinishPreviewArgs): Promise<FinishOutfitPreviewResult>;
}

/** Postgres's deadlock_detected. */
export const DEADLOCK_SQLSTATE = "40P01";

type RpcError = { message: string; code?: string };

/** Run a database function call, retrying once on a deadlock. */
export async function withDeadlockRetry<T>(what: string, call: () => PromiseLike<{ data: unknown; error: RpcError | null }>, parse: (data: unknown) => T): Promise<T> {
  let result = await call();
  if (result.error?.code === DEADLOCK_SQLSTATE) {
    console.warn(`${what}: deadlock, retrying once`);
    result = await call();
  }
  if (result.error) throw new Error(`Couldn't ${what}: ${result.error.message}`);
  return parse(result.data);
}

export class SupabasePreviewRepository implements PreviewRepository {
  constructor(
    /** The signed-in user's client (row-level security applies). */
    private readonly client: SupabaseClient,
    /** The admin (secret key) client, for the server-only database functions. */
    private readonly admin: SupabaseClient,
  ) {}

  async getModelPresetId(userId: string): Promise<string | null> {
    const { data, error } = await this.client.from("user_settings").select("model_preset_id").eq("user_id", userId).maybeSingle();
    if (error) throw new Error(`Couldn't load your settings: ${error.message}`);
    if (!data) return null;
    return UserSettingsRowSchema.pick({ model_preset_id: true }).parse(data).model_preset_id;
  }

  async getOutfitSource(userId: string, outfitId: string): Promise<PreviewOutfitSource | null> {
    const { data, error } = await this.client.from("outfits").select(OUTFIT_COLUMNS).eq("user_id", userId).eq("id", outfitId).maybeSingle();
    if (error) throw new Error(`Couldn't load the outfit: ${error.message}`);
    if (!data) return null;
    const row = OutfitRowSchema.parse(data);
    const items = await this.client.from("items").select(ITEM_COLUMNS).eq("user_id", userId).in("id", row.item_ids);
    if (items.error) throw new Error(`Couldn't load the outfit's items: ${items.error.message}`);
    const byId = new Map((items.data ?? []).map((r) => ItemRowSchema.parse(r)).map((r) => [r.id, itemRowToWardrobeEntry(r)]));
    // An item deleted mid-request takes its outfits with it.
    if (!row.item_ids.every((id) => byId.has(id))) return null;
    return { row, items: row.item_ids.map((id) => byId.get(id)!) };
  }

  async getPreview(userId: string, previewId: string): Promise<OutfitPreviewRow | null> {
    const { data, error } = await this.client.from("outfit_previews").select(PREVIEW_COLUMNS).eq("user_id", userId).eq("id", previewId).maybeSingle();
    if (error) throw new Error(`Couldn't load the preview: ${error.message}`);
    return data ? OutfitPreviewRowSchema.parse(data) : null;
  }

  claim(args: ClaimPreviewArgs): Promise<ClaimOutfitPreviewResult> {
    return withDeadlockRetry(
      "claim the outfit preview",
      () =>
        this.admin.rpc("claim_outfit_preview", {
          p_user: args.userId,
          p_outfit: args.outfitId,
          p_cache_key: args.cacheKey,
          p_preset_id: args.presetId,
          p_refresh: args.refresh,
          p_stale_seconds: PREVIEW_PENDING_STALE_SECONDS,
          p_retry_seconds: PREVIEW_FAILED_RETRY_SECONDS,
        }),
      (data) => ClaimOutfitPreviewResultSchema.parse(data),
    );
  }

  finish(args: FinishPreviewArgs): Promise<FinishOutfitPreviewResult> {
    return withDeadlockRetry(
      "finish the outfit preview",
      () =>
        this.admin.rpc("finish_outfit_preview", {
          p_user: args.userId,
          p_preview: args.previewId,
          p_status: args.status,
          p_image_key: args.status === "ready" ? args.imageKey : null,
          p_failure_reason: args.status === "ready" ? null : args.failureReason,
        }),
      (data) => FinishOutfitPreviewResultSchema.parse(data),
    );
  }
}
