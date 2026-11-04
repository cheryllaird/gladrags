/**
 * Gaps in words and in the collage (spec: "Gaps and shop suggestions"):
 * turning a gap into a collage slot, describing an outfit with gaps for
 * screen readers, and the "add shoes to complete these" notice. Pure, so
 * it's unit-tested without rendering.
 */
import { SHOPS_BY_ID, type Category, type OutfitGap, type ShopProduct, type WardrobeItem } from "@/contracts";
import { COLOUR_SWATCHES } from "@/components/wardrobe/labels";
import type { CollageItem } from "./collage-layout";

/** A gap as a collage slot: no picture, a dashed placeholder with its description and colours. */
export function gapToCollageItem(gap: OutfitGap): CollageItem {
  return {
    id: `gap:${gap.category}`,
    category: gap.category,
    imageUrl: null,
    label: gap.description,
    gap: {
      description: gap.description,
      swatches: gap.colours.map((colour) => COLOUR_SWATCHES[colour]),
      productTitle: gap.shopProduct?.title ?? null,
    },
  };
}

/** The collage's accessible name: the owned items, then each gap as a suggestion. */
export function collageDescription(items: readonly Pick<WardrobeItem, "tags">[], gaps: readonly OutfitGap[] = []): string {
  const owned = items.map((i) => i.tags.description);
  const suggested = gaps.map((g) => `suggested ${g.shopProduct ? g.shopProduct.title : g.description} (not in your wardrobe)`);
  return `Collage of ${[...owned, ...suggested].join(", ")}`;
}

/** Plural nouns for the "add … to your wardrobe" notice. */
const CATEGORY_NOUNS: Record<Category, string> = {
  top: "tops",
  bottom: "trousers or skirts",
  dress_jumpsuit: "dresses or jumpsuits",
  outerwear: "a jacket or coat",
  shoes: "shoes",
};

/** "a, b and c" */
function listInWords(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

/**
 * For a successful response with `missingCategories`: "Add shoes to your
 * wardrobe to complete these outfits." Null when nothing is missing.
 */
export function missingCategoriesMessage(categories: readonly Category[]): string | null {
  if (categories.length === 0) return null;
  return `Add ${listInWords(categories.map((c) => CATEGORY_NOUNS[c]))} to your wardrobe to complete these outfits.`;
}

/** "Suggested shoes", for the gap's row in the item list. */
export const GAP_SLOT_LABELS: Record<Category, string> = {
  top: "Suggested top",
  bottom: "Suggested bottom",
  dress_jumpsuit: "Suggested dress or jumpsuit",
  outerwear: "Suggested outerwear",
  shoes: "Suggested shoes",
};

/** "Next", "M&S"… */
export function shopName(product: Pick<ShopProduct, "shopId">): string {
  return SHOPS_BY_ID[product.shopId].name;
}

/** Where "I've bought this" goes: add-by-link with the product page filled in (the user taps to import). */
export function addBoughtProductHref(product: Pick<ShopProduct, "url">): string {
  return `/add/link?url=${encodeURIComponent(product.url)}`;
}
