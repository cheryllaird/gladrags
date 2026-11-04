import type { Category, FeedbackKind, GapDescription, Outfit, OutfitGap, OutfitStatus, ShopId, StoredOutfitRequest } from "@/contracts";
import type { WardrobeEntry } from "./types";

/** GET /api/outfits returns at most this many, newest first. */
export const OUTFIT_LIST_LIMIT = 100;

export interface NewOutfit {
  request: StoredOutfitRequest;
  name: string;
  reason: string;
  itemIds: string[];
  /** The model's descriptions of the gap slots; stored with no shop results yet. */
  gaps: GapDescription[];
  parentOutfitId: string | null;
}

/** A rejected outfit's shape, for "avoid" hints and not suggesting it again. */
export interface RejectedOutfit {
  itemIds: string[];
  gaps: Category[];
}

/** A gap as first stored: the model's description, nothing searched or chosen yet. */
export function newGap(gap: GapDescription): OutfitGap {
  return { ...gap, shopResults: [], searchedAt: null, shopProduct: null };
}

/**
 * Where the outfit engine reads the wardrobe and keeps outfits and
 * feedback: Supabase for real, the in-memory mock store in mock mode. Every
 * method is scoped to one user; another user's rows are "not found".
 */
export interface OutfitRepository {
  /** All the user's items, with tags and where their picture is stored. */
  listWardrobe(userId: string): Promise<WardrobeEntry[]>;
  /** Newest first, at most OUTFIT_LIST_LIMIT. */
  listOutfits(userId: string, status?: OutfitStatus): Promise<Outfit[]>;
  getOutfit(userId: string, outfitId: string): Promise<Outfit | null>;
  /** Saves new outfits (status "suggested") and returns them in the same order. */
  insertOutfits(userId: string, outfits: readonly NewOutfit[]): Promise<Outfit[]>;
  /** Null when the outfit isn't the user's. */
  setStatus(userId: string, outfitId: string, status: OutfitStatus): Promise<Outfit | null>;
  /** Replaces the outfit's gaps (shop results, chosen product). Null when the outfit isn't the user's. */
  updateGaps(userId: string, outfitId: string, gaps: readonly OutfitGap[]): Promise<Outfit | null>;
  addFeedback(userId: string, outfitId: string, kind: FeedbackKind, detail: string | null): Promise<void>;
  /** The user's rejected outfits (items and gap slots), newest first, at most `limit`. */
  listRejectedOutfits(userId: string, limit: number): Promise<RejectedOutfit[]>;
  /** The shops "Find in my shops" searches (user_settings.favourite_shop_ids). */
  getFavouriteShopIds(userId: string): Promise<ShopId[]>;
}
