/**
 * Mock wardrobe for mock mode and tests: a small mixed menswear/womenswear
 * wardrobe with every category. Images are placeholder SVGs in public/mock.
 */
import type { ItemTags, WardrobeItem } from "@/contracts";

const CREATED_AT = "2026-10-21T09:00:00.000Z";

function mockItem(
  n: number,
  slug: string,
  tags: ItemTags,
  sourceUrl: string | null = null,
  hasCutout = true,
): WardrobeItem {
  const suffix = String(n).padStart(12, "0");
  return {
    id: `1a000000-0000-4000-8000-${suffix}`,
    source: sourceUrl ? "link" : "photo",
    sourceUrl,
    originalUrl: `/mock/items/${slug}.svg`,
    cutoutUrl: hasCutout ? `/mock/items/${slug}.svg` : null,
    tags,
    tagsEdited: false,
    createdAt: CREATED_AT,
  };
}

export const MOCK_ITEMS: readonly WardrobeItem[] = [
  mockItem(1, "white-tshirt", {
    category: "top", subcategory: "t_shirt", colours: ["white"], pattern: "plain", formality: 1,
    seasons: ["spring", "summer", "autumn"], warmth: "light", occasions: ["comfy", "casual", "active", "holiday"],
    fabric: "cotton", description: "White crew-neck t-shirt",
  }),
  mockItem(2, "blue-oxford-shirt", {
    category: "top", subcategory: "shirt", colours: ["light_blue"], pattern: "plain", formality: 3,
    seasons: ["spring", "summer", "autumn", "winter"], warmth: "light", occasions: ["smart_casual", "work"],
    fabric: "cotton", description: "Light blue oxford shirt",
  }),
  mockItem(3, "grey-jumper", {
    category: "top", subcategory: "jumper", colours: ["grey"], pattern: "plain", formality: 2,
    seasons: ["autumn", "winter"], warmth: "warm", occasions: ["casual", "smart_casual", "comfy"],
    fabric: "wool", description: "Grey merino crew jumper",
  }),
  mockItem(4, "blue-jeans", {
    category: "bottom", subcategory: "jeans", colours: ["blue"], pattern: "plain", formality: 2,
    seasons: ["spring", "summer", "autumn", "winter"], warmth: "medium", occasions: ["casual", "smart_casual", "holiday"],
    fabric: "denim", description: "Mid-blue straight-leg jeans",
  }),
  mockItem(5, "tan-chinos", {
    category: "bottom", subcategory: "chinos", colours: ["tan"], pattern: "plain", formality: 3,
    seasons: ["spring", "summer", "autumn"], warmth: "medium", occasions: ["smart_casual", "work", "holiday"],
    fabric: "cotton", description: "Tan slim chinos",
  }, "https://shop.example.com/products/tan-chinos"),
  mockItem(6, "black-skirt", {
    category: "bottom", subcategory: "skirt", colours: ["black"], pattern: "plain", formality: 3,
    seasons: ["spring", "autumn", "winter"], warmth: "medium", occasions: ["work", "evening_out"],
    fabric: null, description: "Black A-line midi skirt",
  }),
  mockItem(7, "green-floral-dress", {
    category: "dress_jumpsuit", subcategory: "dress", colours: ["green", "white"], pattern: "floral", formality: 4,
    seasons: ["spring", "summer"], warmth: "light", occasions: ["wedding_guest", "evening_out", "holiday"],
    fabric: "viscose", description: "Green floral wrap midi dress",
  }),
  mockItem(8, "navy-blazer", {
    category: "outerwear", subcategory: "blazer", colours: ["navy"], pattern: "plain", formality: 4,
    seasons: ["spring", "autumn", "winter"], warmth: "medium", occasions: ["work", "evening_out", "wedding_guest", "smart_casual"],
    fabric: "wool", description: "Navy single-breasted blazer",
  }),
  mockItem(9, "camel-coat", {
    category: "outerwear", subcategory: "coat", colours: ["tan"], pattern: "plain", formality: 3,
    seasons: ["autumn", "winter"], warmth: "warm", occasions: ["work", "smart_casual", "evening_out"],
    fabric: "wool", description: "Camel wool overcoat",
  }, null, false), // No cut-out: background removal failed on the phone; the UI shows the original.
  mockItem(10, "white-trainers", {
    category: "shoes", subcategory: "trainers", colours: ["white"], pattern: "plain", formality: 2,
    seasons: ["spring", "summer", "autumn"], warmth: "medium", occasions: ["casual", "active", "holiday", "smart_casual"],
    fabric: "leather", description: "White leather trainers",
  }),
  mockItem(11, "tan-loafers", {
    category: "shoes", subcategory: "loafers", colours: ["tan"], pattern: "plain", formality: 3,
    seasons: ["spring", "summer", "autumn"], warmth: "medium", occasions: ["smart_casual", "work"],
    fabric: "suede", description: "Tan suede loafers",
  }),
  mockItem(12, "black-heels", {
    category: "shoes", subcategory: "heels", colours: ["black"], pattern: "plain", formality: 4,
    seasons: ["spring", "summer", "autumn", "winter"], warmth: "light", occasions: ["evening_out", "wedding_guest", "formal_event"],
    fabric: "leather", description: "Black block-heel courts",
  }),
];

/** Shown for any photo uploaded in mock mode. */
export const MOCK_UPLOAD_IMAGE_URL = "/mock/items/uploaded.svg";

/** Suggested tags the mock tagger returns for an upload. */
export const MOCK_SUGGESTED_TAGS: ItemTags = {
  category: "top",
  subcategory: "shirt",
  colours: ["navy", "white"],
  pattern: "stripe",
  formality: 2,
  seasons: ["spring", "summer"],
  warmth: "light",
  occasions: ["casual", "smart_casual", "holiday"],
  fabric: "linen",
  description: "Navy and white striped linen shirt",
};

/** Canned names and reasons for mock outfits. */
export const MOCK_OUTFIT_COPY: readonly { name: string; reason: string }[] = [
  { name: "Easy weekend", reason: "Mock suggestion: relaxed pieces in calm, easy colours" },
  { name: "Sharp but relaxed", reason: "Mock suggestion: one smart piece lifts the rest without trying too hard" },
  { name: "Tonal neutrals", reason: "Mock suggestion: neutrals in similar shades keep it put together" },
  { name: "Bit of contrast", reason: "Mock suggestion: a light top against a darker base keeps it crisp" },
  { name: "Layered up", reason: "Mock suggestion: the outer layer adds structure and warmth" },
];
