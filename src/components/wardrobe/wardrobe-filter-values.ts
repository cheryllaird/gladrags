/**
 * Wardrobe filter state, kept in the page URL (?category=top&q=linen) so
 * the back button and a reload keep the user's filters. Values are checked
 * against the same contract the API uses; anything invalid is dropped.
 */
import { CategorySchema, ColourSchema, PresetStyleIdSchema, type Category, type Colour, type ItemListQuery, type PresetStyleId } from "@/contracts";

export interface WardrobeFilters {
  category: Category | "";
  colour: Colour | "";
  occasion: PresetStyleId | "";
  q: string;
}

export const NO_FILTERS: WardrobeFilters = { category: "", colour: "", occasion: "", q: "" };

/** Search is capped at the API's 100 characters. */
export const SEARCH_MAX_LENGTH = 100;

type ParamSource = URLSearchParams | Record<string, string | string[] | undefined>;

function read(source: ParamSource, key: string): string | undefined {
  if (source instanceof URLSearchParams) return source.get(key) ?? undefined;
  const value = source[key];
  return Array.isArray(value) ? value[value.length - 1] : value;
}

export function filtersFromParams(source: ParamSource): WardrobeFilters {
  const category = CategorySchema.safeParse(read(source, "category"));
  const colour = ColourSchema.safeParse(read(source, "colour"));
  const occasion = PresetStyleIdSchema.safeParse(read(source, "occasion"));
  return {
    category: category.success ? category.data : "",
    colour: colour.success ? colour.data : "",
    occasion: occasion.success ? occasion.data : "",
    q: (read(source, "q") ?? "").slice(0, SEARCH_MAX_LENGTH),
  };
}

/** Only the filters that are set, as the API query. */
export function filtersToQuery(filters: WardrobeFilters): ItemListQuery {
  const query: ItemListQuery = {};
  if (filters.category) query.category = filters.category;
  if (filters.colour) query.colour = filters.colour;
  if (filters.occasion) query.occasion = filters.occasion;
  const q = filters.q.trim();
  if (q) query.q = q;
  return query;
}

export function filtersToSearch(filters: WardrobeFilters): string {
  const params = new URLSearchParams(filtersToQuery(filters) as Record<string, string>);
  const search = params.toString();
  return search ? `?${search}` : "";
}

export function hasActiveFilters(filters: WardrobeFilters): boolean {
  return Object.keys(filtersToQuery(filters)).length > 0;
}
