/**
 * The user's settings (CONTRACTS.md section 2, user_settings; section 5,
 * "Settings"): favourite shops and the forwarding token. Uses the
 * signed-in user's client, so RLS applies: a user reads only their own
 * row, may change only favourite_shop_ids, and resets the token through
 * the reset_forwarding_token() database function (it can't be chosen).
 */
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  FavouriteShopIdsSchema,
  ForwardingTokenSchema,
  ModelPresetIdSchema,
  forwardingAddress,
  type ForwardingAddressConfig,
  type ShopId,
  type UserSettings,
} from "@/contracts";
import { z } from "zod";

export interface StoredSettings {
  favouriteShopIds: ShopId[];
  forwardingToken: string;
  /** Round 2: null (or missing) until the user picks a model preset. */
  modelPresetId?: string | null;
}

/** What PUT /api/settings may change: either or both. */
export interface SettingsChange {
  favouriteShopIds?: readonly ShopId[];
  modelPresetId?: string;
}

export interface SettingsRepository {
  /** Null only if the row is missing (it's created with the profile). */
  get(userId: string): Promise<StoredSettings | null>;
  setFavouriteShops(userId: string, shopIds: readonly ShopId[]): Promise<StoredSettings | null>;
  /** Round 2: favourite shops and/or the model preset. */
  update(userId: string, change: SettingsChange): Promise<StoredSettings | null>;
  /** A new random token for the signed-in user; the old address stops working at once. */
  resetForwardingToken(userId: string): Promise<StoredSettings | null>;
}

/** The API shape: the address is null while INBOUND_EMAIL_DOMAIN isn't set. */
export function toUserSettings(stored: StoredSettings, config: ForwardingAddressConfig | null): UserSettings {
  return {
    modelPresetId: stored.modelPresetId ?? null,
    favouriteShopIds: stored.favouriteShopIds,
    forwardingAddress: config ? forwardingAddress(stored.forwardingToken, config) : null,
  };
}

const RowSchema = z.object({
  favourite_shop_ids: FavouriteShopIdsSchema,
  forwarding_token: ForwardingTokenSchema,
  model_preset_id: ModelPresetIdSchema.nullable(),
});
const COLUMNS = "favourite_shop_ids, forwarding_token, model_preset_id";

function toStored(data: unknown): StoredSettings | null {
  if (!data) return null;
  const row = RowSchema.parse(data);
  return { favouriteShopIds: row.favourite_shop_ids, forwardingToken: row.forwarding_token, modelPresetId: row.model_preset_id };
}

export class SupabaseSettingsRepository implements SettingsRepository {
  constructor(private readonly db: SupabaseClient) {}

  async get(userId: string): Promise<StoredSettings | null> {
    const { data, error } = await this.db.from("user_settings").select(COLUMNS).eq("user_id", userId).maybeSingle();
    if (error) throw new Error(`Couldn't read the settings: ${error.message}`);
    return toStored(data);
  }

  async setFavouriteShops(userId: string, shopIds: readonly ShopId[]): Promise<StoredSettings | null> {
    return this.update(userId, { favouriteShopIds: shopIds });
  }

  async update(userId: string, change: SettingsChange): Promise<StoredSettings | null> {
    const columns: Record<string, unknown> = {};
    if (change.favouriteShopIds) columns.favourite_shop_ids = [...change.favouriteShopIds];
    if (change.modelPresetId) columns.model_preset_id = change.modelPresetId;
    const { data, error } = await this.db.from("user_settings").update(columns).eq("user_id", userId).select(COLUMNS).maybeSingle();
    if (error) throw new Error(`Couldn't save the settings: ${error.message}`);
    return toStored(data);
  }

  async resetForwardingToken(userId: string): Promise<StoredSettings | null> {
    // Acts on auth.uid(), the signed-in user this client belongs to.
    const { error } = await this.db.rpc("reset_forwarding_token");
    if (error) throw new Error(`Couldn't reset the forwarding address: ${error.message}`);
    return this.get(userId);
  }
}

/** For tests. */
export class InMemorySettingsRepository implements SettingsRepository {
  readonly rows = new Map<string, StoredSettings>();

  async get(userId: string): Promise<StoredSettings | null> {
    const row = this.rows.get(userId);
    return row ? structuredClone(row) : null;
  }

  async setFavouriteShops(userId: string, shopIds: readonly ShopId[]): Promise<StoredSettings | null> {
    return this.update(userId, { favouriteShopIds: shopIds });
  }

  async update(userId: string, change: SettingsChange): Promise<StoredSettings | null> {
    const row = this.rows.get(userId);
    if (!row) return null;
    if (change.favouriteShopIds) row.favouriteShopIds = [...change.favouriteShopIds];
    if (change.modelPresetId) row.modelPresetId = change.modelPresetId;
    return structuredClone(row);
  }

  async resetForwardingToken(userId: string): Promise<StoredSettings | null> {
    const row = this.rows.get(userId);
    if (!row) return null;
    row.forwardingToken = crypto.randomUUID().replaceAll("-", "");
    return structuredClone(row);
  }
}
