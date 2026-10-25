import type { Outfit, OutfitStatus } from "@/contracts";

export type SavedFilter = "all" | "saved" | "liked";

/**
 * Which outfits a filter shows. It goes by each outfit's current status
 * (including changes made on this screen), but an outfit changed during
 * this visit also stays under the filter it was found under, so un-saving
 * doesn't make the card jump away from under your thumb.
 */
export function outfitsForFilter(
  outfits: readonly Outfit[],
  filter: SavedFilter,
  statuses: Readonly<Record<string, OutfitStatus>>,
): Outfit[] {
  if (filter === "all") return [...outfits];
  return outfits.filter((o) => (statuses[o.id] ?? o.status) === filter || (o.id in statuses && o.status === filter));
}
