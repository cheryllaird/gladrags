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
  forwardingAddress,
  type ForwardingAddressConfig,
  type ShopId,
  type UserSettings,
} from "@/contracts";
import { z } from "zod";

export interface StoredSettings {
  favouriteShopIds: ShopId[];
  forwardingToken: string;
}

export interface SettingsRepository {
  /** Null only if the row is missing (it's created with the profile). */
  get(userId: string): Promise<StoredSettings | null>;
  setFavouriteShops(userId: string, shopIds: readonly ShopId[]): Promise<StoredSettings | null>;
  /** A new random token for the signed-in user; the old address stops working at once. */
  resetForwardingToken(userId: string): Promise<StoredSettings | null>;
}

/** The API shape: the address is null while INBOUND_EMAIL_DOMAIN isn't set. */
export function toUserSettings(stored: StoredSettings, config: ForwardingAddressConfig | null): UserSettings {
  return {
    favouriteShopIds: stored.favouriteShopIds,
    forwardingAddress: config ? forwardingAddress(stored.forwardingToken, config) : null,
  };
}

const RowSchema = z.object({ favourite_shop_ids: FavouriteShopIdsSchema, forwarding_token: ForwardingTokenSchema });

function toStored(data: unknown): StoredSettings | null {
  if (!data) return null;
  const row = RowSchema.parse(data);
  return { favouriteShopIds: row.favourite_shop_ids, forwardingToken: row.forwarding_token };
}

export class SupabaseSettingsRepository implements SettingsRepository {
  constructor(private readonly db: SupabaseClient) {}

  async get(userId: string): Promise<StoredSettings | null> {
    const { data, error } = await this.db.from("user_settings").select("favourite_shop_ids, forwarding_token").eq("user_id", userId).maybeSingle();
    if (error) throw new Error(`Couldn't read the settings: ${error.message}`);
    return toStored(data);
  }

  async setFavouriteShops(userId: string, shopIds: readonly ShopId[]): Promise<StoredSettings | null> {
    const { data, error } = await this.db
      .from("user_settings")
      .update({ favourite_shop_ids: [...shopIds] })
      .eq("user_id", userId)
      .select("favourite_shop_ids, forwarding_token")
      .maybeSingle();
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
    const row = this.rows.get(userId);
    if (!row) return null;
    row.favouriteShopIds = [...shopIds];
    return structuredClone(row);
  }

  async resetForwardingToken(userId: string): Promise<StoredSettings | null> {
    const row = this.rows.get(userId);
    if (!row) return null;
    row.forwardingToken = crypto.randomUUID().replaceAll("-", "");
    return structuredClone(row);
  }
}
