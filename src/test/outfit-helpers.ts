/**
 * Builders for outfit-engine tests: wardrobe items with sensible default
 * tags, and big random wardrobes. Test-only.
 */
import { SUBCATEGORIES, type Category, type ItemTags } from "@/contracts";
import type { WardrobeEntry } from "@/lib/outfits/types";

/** A valid UUID from a number, e.g. uuid(7) = 2b000000-0000-4000-8000-000000000007. */
export function uuid(n: number): string {
  return `2b000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

const DEFAULT_SUB: Record<Category, ItemTags["subcategory"]> = {
  top: "shirt",
  bottom: "chinos",
  dress_jumpsuit: "dress",
  outerwear: "blazer",
  shoes: "loafers",
};

export function entry(n: number, category: Category, tags: Partial<ItemTags> = {}): WardrobeEntry {
  return {
    id: uuid(n),
    tags: {
      category,
      subcategory: DEFAULT_SUB[category],
      colours: ["navy"],
      pattern: "plain",
      formality: 3,
      seasons: ["spring", "summer", "autumn", "winter"],
      warmth: "medium",
      occasions: ["work", "smart_casual"],
      fabric: null,
      description: `${category} ${n}`,
      ...tags,
    },
    image: { bucket: "cutouts", key: `0a000000-0000-4000-8000-000000000001/${uuid(n)}.png` },
  };
}

/** An items-table row (as Supabase returns it) for a test item. */
export function toItemRow(item: WardrobeEntry, userId: string, { withCutout = true } = {}) {
  const n = Number(item.id.slice(-12));
  const t = item.tags;
  return {
    id: item.id,
    user_id: userId,
    source: "photo",
    source_url: null,
    original_image_key: `${userId}/${uuid(n + 500)}.jpg`,
    cutout_image_key: withCutout ? `${userId}/${uuid(n + 600)}.png` : null,
    category: t.category,
    subcategory: t.subcategory,
    colours: t.colours,
    pattern: t.pattern,
    formality: t.formality,
    seasons: t.seasons,
    warmth: t.warmth,
    occasions: t.occasions,
    fabric: t.fabric,
    description: t.description,
    tags_edited: false,
    created_at: "2026-10-21 09:00:00+00",
  };
}

/** A wardrobe with the given number of items per category. IDs count up from `start`. */
export function wardrobe(counts: Partial<Record<Category, number>>, tags: Partial<ItemTags> = {}, start = 1): WardrobeEntry[] {
  const items: WardrobeEntry[] = [];
  let n = start;
  for (const [category, count] of Object.entries(counts) as [Category, number][]) {
    for (let i = 0; i < count; i++) items.push(entry(n++, category, tags));
  }
  return items;
}

/** A big wardrobe with varied formality and seasons, from a random source. */
export function randomWardrobe(size: number, random: () => number): WardrobeEntry[] {
  const categories: Category[] = ["top", "top", "bottom", "bottom", "dress_jumpsuit", "outerwear", "shoes", "shoes"];
  const seasonSets: ItemTags["seasons"][] = [["spring", "summer"], ["autumn", "winter"], ["spring", "summer", "autumn", "winter"]];
  return Array.from({ length: size }, (_, i) => {
    const category = categories[Math.floor(random() * categories.length)]!;
    const subs = SUBCATEGORIES[category];
    return entry(i + 1, category, {
      subcategory: subs[Math.floor(random() * subs.length)]!,
      formality: 1 + Math.floor(random() * 5),
      seasons: seasonSets[Math.floor(random() * seasonSets.length)]!,
    });
  });
}
