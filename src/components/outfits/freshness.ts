/**
 * Image URLs from the API are signed and expire after an hour
 * (docs/CONTRACTS.md, section 2). Outfits fetched longer ago than this are
 * fetched again before they're shown again, so their pictures still load.
 */
import type { Outfit } from "@/contracts";
import { outfitsApi } from "./api";

export const REFETCH_AFTER_MS = 50 * 60 * 1000;

export function isStale(fetchedAt: number, now: number = Date.now()): boolean {
  return now - fetchedAt >= REFETCH_AFTER_MS;
}

/**
 * Fetch each outfit again for fresh image URLs. An outfit that can't be
 * fetched (e.g. deleted, or offline) is kept as it was; its collage then
 * offers "Reload pictures".
 */
export async function refetchOutfits(outfits: readonly Outfit[]): Promise<Outfit[]> {
  const results = await Promise.all(outfits.map((o) => outfitsApi.getOutfit(o.id)));
  return outfits.map((o, i) => {
    const result = results[i];
    return result?.ok ? result.data.outfit : o;
  });
}
