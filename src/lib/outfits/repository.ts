import type { FeedbackKind, Outfit, OutfitStatus, StoredOutfitRequest } from "@/contracts";
import type { WardrobeEntry } from "./types";

/** GET /api/outfits returns at most this many, newest first. */
export const OUTFIT_LIST_LIMIT = 100;

export interface NewOutfit {
  request: StoredOutfitRequest;
  name: string;
  reason: string;
  itemIds: string[];
  parentOutfitId: string | null;
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
  addFeedback(userId: string, outfitId: string, kind: FeedbackKind, detail: string | null): Promise<void>;
  /** Item IDs of the user's rejected outfits, newest first, at most `limit`. */
  listRejectedItemIds(userId: string, limit: number): Promise<string[][]>;
}
