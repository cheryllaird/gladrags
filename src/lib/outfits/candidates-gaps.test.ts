/**
 * Candidate generation with gaps (milestone 5). Pure: every candidate
 * must pass the shared checkRankedOutfits with the same gap rules the
 * model's picks are judged by.
 */
import { describe, expect, it } from "vitest";
import { MAX_SHOP_ITEM_GAPS, checkRankedOutfits, missingCategoriesForOutfits, type Category, type GapRules } from "@/contracts";
import { randomWardrobe, wardrobe } from "@/test/outfit-helpers";
import { generateGapCandidates, generateOutfitCandidates, seededRandom, shapeKey, type Candidate } from "./candidates";
import { GAP_CANDIDATE_SHARE } from "./config";
import type { WardrobeEntry } from "./types";

const rulesFor = (items: readonly WardrobeEntry[], includeShopItems = false): GapRules => ({
  fillableCategories: new Set(items.map((i) => i.tags.category)),
  includeShopItems,
});

function gaps(items: WardrobeEntry[], options: { includeShopItems?: boolean; anchor?: string; limit?: number; seed?: number } = {}) {
  return generateGapCandidates(items, {
    gapRules: rulesFor(items, options.includeShopItems),
    requiredIds: options.anchor ? [options.anchor] : [],
    anchorItemId: options.anchor,
    limit: options.limit ?? 60,
    random: seededRandom(options.seed ?? 1),
  });
}

const categoryOf = (items: WardrobeEntry[]) => (id: string) => items.find((i) => i.id === id)!.tags.category;

function expectAllValid(candidates: Candidate[], items: WardrobeEntry[], rules: GapRules, anchorItemId?: string) {
  const known = new Map(items.map((i) => [i.id, i.tags.category] as const));
  const check = checkRankedOutfits(
    candidates.map((c) => ({ itemIds: c.itemIds, gaps: c.gaps.map((category) => ({ category })) })),
    known,
    { anchorItemId, gaps: rules },
  );
  expect(check.rejected).toEqual([]);
  for (const c of candidates) expect(c.itemIds.length).toBeGreaterThan(0);
}

describe("generateGapCandidates: a wardrobe missing categories", () => {
  it("one top: the top, with a bottom gap and a shoes gap", () => {
    const items = wardrobe({ top: 1 });
    expect(gaps(items)).toEqual([{ itemIds: [items[0]!.id], gaps: ["bottom", "shoes"] }]);
  });

  it("one dress: the dress with a shoes gap", () => {
    const items = wardrobe({ dress_jumpsuit: 1 });
    expect(gaps(items)).toEqual([{ itemIds: [items[0]!.id], gaps: ["shoes"] }]);
  });

  it("only shoes: a dress gap comes before a top and bottom gap (fewer gaps first)", () => {
    const items = wardrobe({ shoes: 1 });
    const found = gaps(items);
    expect(found.map((c) => c.gaps)).toEqual([["dress_jumpsuit"], ["top", "bottom"]]);
    expectAllValid(found, items, rulesFor(items));
  });

  it("no shoes: every candidate has exactly a shoes gap", () => {
    const items = wardrobe({ top: 2, bottom: 2, dress_jumpsuit: 1, outerwear: 1 });
    const found = gaps(items);
    // (2×2 + 1) bodies × (no coat, coat) = 10.
    expect(found).toHaveLength(10);
    for (const c of found) expect(c.gaps).toEqual(["shoes"]);
    expectAllValid(found, items, rulesFor(items));
  });

  it("tops and a dress but no bottoms: tops get a bottom gap; the dress isn't given gaps it doesn't need", () => {
    const items = wardrobe({ top: 2, dress_jumpsuit: 1, shoes: 1 });
    const found = gaps(items);
    expect(found.length).toBe(2);
    for (const c of found) {
      expect(c.gaps).toEqual(["bottom"]);
      expect(categoryOf(items)(c.itemIds[0]!)).toBe("top");
    }
  });

  it("a complete wardrobe without shop items has no gap candidates", () => {
    expect(gaps(wardrobe({ top: 2, bottom: 2, shoes: 2, outerwear: 1, dress_jumpsuit: 1 }))).toEqual([]);
  });

  it("an empty wardrobe has none (every outfit needs an owned item)", () => {
    expect(gaps([])).toEqual([]);
  });
});

describe("generateGapCandidates: shop items", () => {
  const items = wardrobe({ top: 2, bottom: 2, dress_jumpsuit: 1, shoes: 2, outerwear: 1 });

  it("offers exactly one shop-item gap per candidate, in every slot, outerwear included", () => {
    const found = gaps(items, { includeShopItems: true });
    expect(found.length).toBeGreaterThan(0);
    for (const c of found) expect(c.gaps).toHaveLength(MAX_SHOP_ITEM_GAPS);
    expect(new Set(found.flatMap((c) => c.gaps))).toEqual(new Set<Category>(["top", "bottom", "dress_jumpsuit", "shoes", "outerwear"]));
    expectAllValid(found, items, rulesFor(items, true));
  });

  it("takes turns between slots, so one kind of gap doesn't fill the list", () => {
    const found = gaps(items, { includeShopItems: true, limit: 5 });
    expect(new Set(found.map((c) => c.gaps[0])).size).toBeGreaterThanOrEqual(4);
  });

  it("a missing category plus a shop item: the required gap and at most one more", () => {
    const noShoes = wardrobe({ top: 2, bottom: 2 });
    const found = gaps(noShoes, { includeShopItems: true });
    for (const c of found) {
      expect(c.gaps).toContain("shoes");
      expect(c.gaps.length).toBeLessThanOrEqual(2);
    }
    expect(found.some((c) => c.gaps.length === 2)).toBe(true);
    expect(found[0]!.gaps).toEqual(["shoes"]); // fewer gaps first
    expectAllValid(found, noShoes, rulesFor(noShoes, true));
  });
});

describe("generateGapCandidates: anchors and exclusions", () => {
  it("the anchor is always owned, and its slot is never a gap", () => {
    for (const category of ["top", "bottom", "dress_jumpsuit", "shoes", "outerwear"] as const) {
      const items = wardrobe({ top: 1, bottom: 1, dress_jumpsuit: 1, shoes: 1, outerwear: 1 });
      const anchor = items.find((i) => i.tags.category === category)!;
      const found = gaps(items, { includeShopItems: true, anchor: anchor.id });
      expect(found.length).toBeGreaterThan(0);
      for (const c of found) {
        expect(c.itemIds).toContain(anchor.id);
        expect(c.gaps).not.toContain(category);
      }
      expectAllValid(found, items, rulesFor(items, true), anchor.id);
    }
  });

  it("a top anchor with no bottoms gets a bottom gap, never a dress", () => {
    const items = wardrobe({ top: 1, dress_jumpsuit: 2, shoes: 1 });
    const found = gaps(items, { anchor: items[0]!.id });
    expect(found.map((c) => c.gaps)).toEqual([["bottom"]]);
    expect(missingCategoriesForOutfits(rulesFor(items).fillableCategories, "top")).toEqual(["bottom"]);
  });

  it("leaves out excluded gap outfits (a rejected one, the one being refined), matched by items and gap slots", () => {
    const items = wardrobe({ top: 1, bottom: 1 });
    const all = gaps(items);
    expect(all).toHaveLength(1);
    const excluded = generateGapCandidates(items, {
      gapRules: rulesFor(items),
      excludeOutfits: [{ itemIds: all[0]!.itemIds, gaps: ["shoes"] }],
      limit: 60,
      random: seededRandom(1),
    });
    expect(excluded).toEqual([]);
    // A bare list of the same items is a complete outfit: a different shape.
    expect(shapeKey(all[0]!.itemIds)).not.toBe(shapeKey(all[0]!));
  });
});

describe("generateOutfitCandidates: complete outfits first", () => {
  it("puts complete outfits first, then gap outfits, keeping a share of places for gaps", () => {
    const items = wardrobe({ top: 6, dress_jumpsuit: 6, shoes: 3, outerwear: 2 });
    const rules = rulesFor(items);
    const { candidates, complete } = generateOutfitCandidates(items, { gapRules: rules, limit: 20, random: seededRandom(3) });
    expect(candidates).toHaveLength(20);
    expect(complete).toBe(20 - Math.ceil(20 * GAP_CANDIDATE_SHARE));
    expect(candidates.slice(0, complete).every((c) => c.gaps.length === 0)).toBe(true);
    expect(candidates.slice(complete).every((c) => c.gaps.length > 0)).toBe(true);
    expectAllValid(candidates, items, rules);
  });

  it("fills the list with gap outfits when there are few complete ones", () => {
    const items = wardrobe({ top: 1, bottom: 1, shoes: 1, dress_jumpsuit: 0 });
    const { candidates, complete } = generateOutfitCandidates(items, { gapRules: rulesFor(items, true), limit: 20, random: seededRandom(3) });
    expect(complete).toBe(1);
    expect(candidates.length).toBeGreaterThan(1);
    expect(candidates[0]!.gaps).toEqual([]);
  });
});

describe("generateGapCandidates: random wardrobes (property check)", () => {
  it("every candidate passes the shared check, for any wardrobe, anchor and shop setting", () => {
    const random = seededRandom(99);
    for (let round = 0; round < 60; round++) {
      const items = randomWardrobe(1 + Math.floor(random() * 12), random);
      const includeShopItems = random() < 0.5;
      const anchor = random() < 0.4 ? items[Math.floor(random() * items.length)]!.id : undefined;
      const rules = rulesFor(items, includeShopItems);
      const found = generateGapCandidates(items, {
        gapRules: rules,
        requiredIds: anchor ? [anchor] : [],
        anchorItemId: anchor,
        limit: 30,
        random,
      });
      expectAllValid(found, items, rules, anchor);
      expect(new Set(found.map(shapeKey)).size).toBe(found.length);
    }
  });

  it("stays fast on a big wardrobe with shop items on", () => {
    const items = randomWardrobe(200, seededRandom(5));
    const started = performance.now();
    const found = gaps(items, { includeShopItems: true });
    expect(found.length).toBe(60);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
