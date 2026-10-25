/**
 * Pipeline step 1: drop items whose formality, season or occasion tags
 * clearly don't fit the request. Pure functions.
 *
 * "Clearly" is deliberate: the model ranks what's left, so the filter only
 * removes what no stylist would pick.
 *
 * Formality, preset style: an item is kept when
 * - its formality is inside the style's band, or
 * - it's one point outside the band AND the item is tagged for that occasion
 *   (a 4 navy blazer tagged smart casual stays in for smart casual, 2–3).
 * Anything further out is dropped, even if tagged: that's likely a tagging slip.
 *
 * Formality, custom (typed) style: no fixed band, so formality isn't
 * filtered at all. The model judges fit from the text, and candidate
 * generation keeps each outfit's formality coherent (MAX_FORMALITY_SPREAD).
 *
 * Season: items must be worn in today's UK season. Holiday ignores the
 * season (it covers warm-weather trips).
 *
 * Relaxing: a small wardrobe can leave too few outfits after the strict
 * filter. The pipeline then tries FILTER_LEVELS in order: without the
 * season, then also with any item one point outside the band.
 *
 * Items in `keepIds` (the anchor, items kept in a swap) always stay: the
 * user chose them.
 */
import { PRESET_STYLES_BY_ID, type FormalityBand, type ItemTags, type Season, type StyleChoice } from "@/contracts";
import type { TaggedItem } from "./types";

export interface FilterLevel {
  /** Ignore the season. */
  ignoreSeason: boolean;
  /** Keep any item one point outside the band, tagged for the occasion or not. */
  looseFormality: boolean;
}

/** Strictest first. */
export const FILTER_LEVELS: readonly FilterLevel[] = [
  { ignoreSeason: false, looseFormality: false },
  { ignoreSeason: true, looseFormality: false },
  { ignoreSeason: true, looseFormality: true },
];

export interface FilterOptions extends Partial<FilterLevel> {
  style: StyleChoice;
  season: Season;
  /** Always kept, whatever their tags. */
  keepIds?: ReadonlySet<string>;
}

/** The style's formality band, or null for a custom style (no fixed band). */
export function formalityBandFor(style: StyleChoice): FormalityBand | null {
  return style.kind === "preset" ? PRESET_STYLES_BY_ID[style.presetId].formality : null;
}

export function fitsFormality(tags: ItemTags, style: StyleChoice, loose = false): boolean {
  if (style.kind !== "preset") return true;
  const band = PRESET_STYLES_BY_ID[style.presetId].formality;
  const distance = tags.formality < band.min ? band.min - tags.formality : Math.max(0, tags.formality - band.max);
  if (distance === 0) return true;
  return distance === 1 && (loose || tags.occasions.includes(style.presetId));
}

export function seasonMatters(style: StyleChoice): boolean {
  return !(style.kind === "preset" && style.presetId === "holiday");
}

export function fitsSeason(tags: ItemTags, season: Season): boolean {
  return tags.seasons.includes(season);
}

export function filterItems<T extends TaggedItem>(items: readonly T[], options: FilterOptions): T[] {
  const checkSeason = !options.ignoreSeason && seasonMatters(options.style);
  return items.filter((item) => {
    if (options.keepIds?.has(item.id)) return true;
    if (!fitsFormality(item.tags, options.style, options.looseFormality)) return false;
    if (checkSeason && !fitsSeason(item.tags, options.season)) return false;
    return true;
  });
}
