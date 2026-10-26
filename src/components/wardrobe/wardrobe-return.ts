/**
 * The wardrobe filters the user last had, so screens that send them back
 * to the wardrobe (after deleting an item, say) can restore them. Per tab,
 * in sessionStorage; just /wardrobe if nothing is known.
 */
import { filtersFromParams, filtersToSearch } from "./wardrobe-filter-values";

const KEY = "gladrags:wardrobe-search";

export function rememberWardrobeSearch(search: string): void {
  try {
    window.sessionStorage.setItem(KEY, search);
  } catch {
    // Storage unavailable: the wardrobe just opens unfiltered.
  }
}

/** /wardrobe plus the remembered filters, re-checked against the contract vocabularies. */
export function wardrobeReturnPath(): string {
  try {
    const search = window.sessionStorage.getItem(KEY) ?? "";
    return `/wardrobe${filtersToSearch(filtersFromParams(new URLSearchParams(search)))}`;
  } catch {
    return "/wardrobe";
  }
}
