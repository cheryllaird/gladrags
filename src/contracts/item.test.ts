import { describe, expect, it } from "vitest";
import {
  CATEGORIES,
  COLOURS,
  ImageKeySchema,
  ItemTagsSchema,
  PATTERNS,
  SUBCATEGORIES,
  SourceUrlSchema,
  WardrobeItemSchema,
  imageKeyBelongsTo,
  isSubcategoryOf,
  type ItemTags,
} from "@/contracts";
import { MOCK_ITEMS } from "@/lib/mocks/fixtures";

const validTags: ItemTags = {
  category: "top",
  subcategory: "jumper",
  colours: ["navy", "white"],
  pattern: "stripe",
  formality: 2,
  seasons: ["autumn", "winter"],
  warmth: "warm",
  occasions: ["casual", "smart_casual"],
  fabric: "wool",
  description: "Navy and white Breton jumper",
};

const USER = "0a000000-0000-4000-8000-000000000001";
const OTHER_USER = "0b000000-0000-4000-8000-000000000002";

describe("tag vocabularies match the spec", () => {
  it("has the five categories", () => {
    expect(CATEGORIES).toEqual(["top", "bottom", "dress_jumpsuit", "outerwear", "shoes"]);
  });

  it("has the spec's subcategories for tops, bottoms and outerwear", () => {
    expect(SUBCATEGORIES.top).toEqual(["t_shirt", "shirt", "blouse", "polo", "jumper"]);
    expect(SUBCATEGORIES.bottom).toEqual(["jeans", "trousers", "chinos", "skirt", "shorts"]);
    expect(SUBCATEGORIES.outerwear).toEqual(["jacket", "blazer", "coat"]);
  });

  it("has subcategories for every category, with no name used twice", () => {
    const all = Object.values(SUBCATEGORIES).flat();
    expect(new Set(all).size).toBe(all.length);
    for (const category of CATEGORIES) expect(SUBCATEGORIES[category].length).toBeGreaterThan(0);
  });

  it("has the spec's five patterns", () => {
    expect(PATTERNS).toEqual(["plain", "stripe", "floral", "check", "print"]);
  });

  it("has unique colours", () => {
    expect(new Set(COLOURS).size).toBe(COLOURS.length);
  });

  it("knows which subcategory belongs where", () => {
    expect(isSubcategoryOf("shoes", "loafers")).toBe(true);
    expect(isSubcategoryOf("top", "loafers")).toBe(false);
  });
});

describe("ItemTagsSchema", () => {
  it("accepts a complete, consistent tag set", () => {
    expect(ItemTagsSchema.parse(validTags)).toEqual(validTags);
  });

  it("accepts fabric: null (not visible)", () => {
    expect(ItemTagsSchema.safeParse({ ...validTags, fabric: null }).success).toBe(true);
  });

  it("trims text fields", () => {
    const parsed = ItemTagsSchema.parse({ ...validTags, description: "  Breton jumper  " });
    expect(parsed.description).toBe("Breton jumper");
  });

  it.each([
    ["a subcategory from another category", { subcategory: "jeans" }],
    ["an unknown category", { category: "accessory" }],
    ["no colours", { colours: [] }],
    ["more than three colours", { colours: ["red", "blue", "green", "black"] }],
    ["a duplicated colour", { colours: ["navy", "navy"] }],
    ["a colour outside the palette", { colours: ["dusty heather"] }],
    ["an unknown pattern", { pattern: "paisley" }],
    ["formality 0", { formality: 0 }],
    ["formality 6", { formality: 6 }],
    ["fractional formality", { formality: 2.5 }],
    ["no seasons", { seasons: [] }],
    ["American 'fall'", { seasons: ["fall"] }],
    ["an unknown warmth", { warmth: "toasty" }],
    ["no occasions", { occasions: [] }],
    ["an occasion that isn't a preset", { occasions: ["funeral"] }],
    ["an empty description", { description: "   " }],
    ["a multi-line description", { description: "Jumper\nwith stripes" }],
    ["a description over 120 characters", { description: "x".repeat(121) }],
    ["a fabric over 40 characters", { fabric: "x".repeat(41) }],
  ])("rejects %s", (_label, change) => {
    expect(ItemTagsSchema.safeParse({ ...validTags, ...change }).success).toBe(false);
  });

  it("reports a subcategory mismatch on the subcategory field", () => {
    const result = ItemTagsSchema.safeParse({ ...validTags, subcategory: "heels" });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["subcategory"]);
  });
});

describe("images and links", () => {
  it("accepts image keys in '<user id>/<uuid>.<ext>' form", () => {
    expect(ImageKeySchema.safeParse(`${USER}/1a000000-0000-4000-8000-000000000099.png`).success).toBe(true);
  });

  it.each([
    "../etc/passwd",
    `${USER}/photo.png`,
    `${USER}/1a000000-0000-4000-8000-000000000099.gif`,
    `${USER}/sub/1a000000-0000-4000-8000-000000000099.png`,
    `/${USER}/1a000000-0000-4000-8000-000000000099.png`,
  ])("rejects image key %s", (key) => {
    expect(ImageKeySchema.safeParse(key).success).toBe(false);
  });

  it("checks image keys belong to the user", () => {
    const key = `${USER}/1a000000-0000-4000-8000-000000000099.png`;
    expect(imageKeyBelongsTo(key, USER)).toBe(true);
    expect(imageKeyBelongsTo(key, OTHER_USER)).toBe(false);
  });

  it("accepts only http(s) source links", () => {
    expect(SourceUrlSchema.safeParse("https://shop.example.com/p/1").success).toBe(true);
    expect(SourceUrlSchema.safeParse("javascript:alert(1)").success).toBe(false);
    expect(SourceUrlSchema.safeParse("file:///etc/passwd").success).toBe(false);
    expect(SourceUrlSchema.safeParse("not a url").success).toBe(false);
  });
});

describe("mock wardrobe", () => {
  it("matches the WardrobeItem contract", () => {
    for (const item of MOCK_ITEMS) expect(WardrobeItemSchema.safeParse(item).success).toBe(true);
  });

  it("covers every category", () => {
    const present = new Set(MOCK_ITEMS.map((i) => i.tags.category));
    expect([...present].sort()).toEqual([...CATEGORIES].sort());
  });
});
