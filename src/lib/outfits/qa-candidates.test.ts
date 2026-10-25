/**
 * QA gap tests for candidate generation (pipeline step 2): composition for
 * anchors of every category, optional outerwear, determinism and bounds on
 * big and lopsided wardrobes, and variety.
 */
import { describe, expect, it } from "vitest";
import { CATEGORIES, checkComposition, type Category } from "@/contracts";
import { entry, randomWardrobe, wardrobe } from "@/test/outfit-helpers";
import { generateCandidates, outfitKey, seededRandom } from "./candidates";
import { ENUMERATE_LIMIT, MAX_CANDIDATES_SENT } from "./config";
import type { WardrobeEntry } from "./types";

function categoriesOf(ids: string[], items: readonly WardrobeEntry[]): Category[] {
  return ids.map((id) => items.find((i) => i.id === id)!.tags.category);
}

function expectAllWearable(candidates: string[][], items: readonly WardrobeEntry[]) {
  for (const ids of candidates) {
    expect(checkComposition(categoriesOf(ids, items)), ids.join(",")).toEqual({ ok: true });
    expect(new Set(ids).size).toBe(ids.length);
  }
}

const run = (items: readonly WardrobeEntry[], seed: number, extra: { requiredIds?: string[]; limit?: number } = {}) =>
  generateCandidates(items, { limit: extra.limit ?? MAX_CANDIDATES_SENT, random: seededRandom(seed), requiredIds: extra.requiredIds });

describe("QA candidates: every outfit passes checkComposition", () => {
  it("for 200 random wardrobes of mixed sizes, with and without an anchor", () => {
    const rng = seededRandom(4242);
    for (let i = 0; i < 200; i++) {
      const items = randomWardrobe(1 + Math.floor(rng() * 120), rng);
      const anchor = rng() < 0.5 ? items[Math.floor(rng() * items.length)] : undefined;
      const { candidates } = generateCandidates(items, {
        limit: MAX_CANDIDATES_SENT,
        random: rng,
        requiredIds: anchor ? [anchor.id] : [],
      });
      expect(candidates.length).toBeLessThanOrEqual(MAX_CANDIDATES_SENT);
      expectAllWearable(candidates, items);
      if (anchor) for (const ids of candidates) expect(ids).toContain(anchor.id);
    }
  });
});

describe("QA candidates: the anchor is always included, whatever its category", () => {
  const items = wardrobe({ top: 4, bottom: 4, dress_jumpsuit: 2, shoes: 3, outerwear: 2 });

  for (const category of CATEGORIES) {
    it(`anchor is ${category}`, () => {
      const anchor = items.find((i) => i.tags.category === category)!;
      const { candidates } = run(items, 7, { requiredIds: [anchor.id] });
      expect(candidates.length).toBeGreaterThan(0);
      for (const ids of candidates) expect(ids).toContain(anchor.id);
      expectAllWearable(candidates, items);
    });
  }

  it("a shoes anchor still allows both separates and dresses", () => {
    const anchor = items.find((i) => i.tags.category === "shoes")!;
    const { candidates } = run(items, 7, { requiredIds: [anchor.id], limit: 500 });
    const cats = candidates.map((ids) => categoriesOf(ids, items));
    expect(cats.some((c) => c.includes("dress_jumpsuit"))).toBe(true);
    expect(cats.some((c) => c.includes("top") && c.includes("bottom"))).toBe(true);
    // Only one pair of shoes: the anchor.
    for (const ids of candidates) expect(categoriesOf(ids, items).filter((c) => c === "shoes")).toHaveLength(1);
  });

  it("an outerwear anchor is the only outerwear, in every candidate, in a big sampled wardrobe", () => {
    const big = randomWardrobe(200, seededRandom(5));
    const anchor = big.find((i) => i.tags.category === "outerwear" && i.tags.formality === 3)!;
    const { candidates, combinations } = run(big, 3, { requiredIds: [anchor.id] });
    expect(combinations).toBeGreaterThan(ENUMERATE_LIMIT);
    expect(candidates.length).toBeGreaterThan(0);
    for (const ids of candidates) {
      expect(ids).toContain(anchor.id);
      expect(categoriesOf(ids, big).filter((c) => c === "outerwear")).toHaveLength(1);
    }
  });
});

describe("QA candidates: outerwear is optional", () => {
  it("offers outfits both with and without outerwear when there's no outerwear anchor", () => {
    const items = wardrobe({ top: 2, bottom: 2, shoes: 2, outerwear: 2 });
    const { candidates } = run(items, 1, { limit: 1000 });
    const withOuter = candidates.filter((ids) => categoriesOf(ids, items).includes("outerwear"));
    expect(withOuter.length).toBeGreaterThan(0);
    expect(candidates.length - withOuter.length).toBeGreaterThan(0);
    // 2x2 bodies x 2 shoes x (none + 2 coats) = 24 combinations, all listed.
    expect(candidates).toHaveLength(24);
  });

  it("a wardrobe with no outerwear at all still makes outfits", () => {
    const items = wardrobe({ dress_jumpsuit: 1, shoes: 1 });
    expect(run(items, 1).candidates).toEqual([[items[0]!.id, items[1]!.id]]);
  });
});

describe("QA candidates: deterministic and bounded", () => {
  const cases: [string, WardrobeEntry[]][] = [
    ["200 random items", randomWardrobe(200, seededRandom(11))],
    ["100 shoes, 1 top, 1 bottom", wardrobe({ top: 1, bottom: 1, shoes: 100 })],
    ["100 shoes and 100 coats, 1 top, 1 bottom", wardrobe({ top: 1, bottom: 1, shoes: 100, outerwear: 100 })],
    ["150 tops, 1 bottom, 1 shoes", wardrobe({ top: 150, bottom: 1, shoes: 1 })],
    ["60 tops, 60 bottoms, 40 shoes, 40 coats", wardrobe({ top: 60, bottom: 60, shoes: 40, outerwear: 40 })],
    ["200 dresses, no shoes", wardrobe({ dress_jumpsuit: 200 })],
    ["200 tops only", wardrobe({ top: 200 })],
  ];

  for (const [name, items] of cases) {
    it(`${name}: same seed, same result; at most the cap; quick`, () => {
      const started = performance.now();
      const a = run(items, 123);
      const elapsed = performance.now() - started;
      const b = run(items, 123);
      expect(a).toEqual(b);
      expect(a.candidates.length).toBeLessThanOrEqual(MAX_CANDIDATES_SENT);
      expect(new Set(a.candidates.map(outfitKey)).size).toBe(a.candidates.length);
      expectAllWearable(a.candidates, items);
      expect(elapsed).toBeLessThan(500);
    });
  }

  it("100 shoes, 1 top, 1 bottom: fills the cap of 60 with 60 different shoes", () => {
    const items = wardrobe({ top: 1, bottom: 1, shoes: 100 });
    const { candidates, combinations } = run(items, 9);
    expect(combinations).toBe(100);
    expect(candidates).toHaveLength(MAX_CANDIDATES_SENT);
    expect(new Set(candidates.map((ids) => ids[2])).size).toBe(MAX_CANDIDATES_SENT);
  });

  it("wardrobes that can't make an outfit return no candidates", () => {
    expect(run(wardrobe({ dress_jumpsuit: 200 }), 1).candidates).toEqual([]);
    expect(run(wardrobe({ top: 200 }), 1).candidates).toEqual([]);
    expect(run(wardrobe({ shoes: 100, outerwear: 100 }), 1).candidates).toEqual([]);
  });

  it("a limit of 0 or less returns nothing without looping", () => {
    expect(run(wardrobe({ top: 3, bottom: 3, shoes: 3 }), 1, { limit: 0 }).candidates).toEqual([]);
  });
});

describe("QA candidates: fair variety", () => {
  it("doesn't keep reusing the same top (enumerated wardrobe)", () => {
    const items = wardrobe({ top: 20, bottom: 10, shoes: 10 }); // 2,000 combinations: listed and shuffled
    const { candidates } = run(items, 2);
    const tops = new Set(candidates.map((ids) => ids[0]));
    expect(tops.size).toBeGreaterThanOrEqual(12);
    const mostUsed = Math.max(...[...tops].map((t) => candidates.filter((ids) => ids[0] === t).length));
    expect(mostUsed).toBeLessThanOrEqual(10);
  });

  it("doesn't keep reusing the same top (sampled wardrobe)", () => {
    const items = wardrobe({ top: 40, bottom: 40, shoes: 20, outerwear: 10 }); // 352,000: sampled
    const { candidates, combinations } = run(items, 2);
    expect(combinations).toBeGreaterThan(ENUMERATE_LIMIT);
    expect(new Set(candidates.map((ids) => ids[0])).size).toBeGreaterThanOrEqual(25);
    expect(new Set(candidates.map((ids) => ids[2])).size).toBeGreaterThanOrEqual(15);
  });

  it("the first candidate changes with the seed (refreshing gives a different set)", () => {
    const items = wardrobe({ top: 10, bottom: 10, shoes: 5 });
    const firsts = new Set(Array.from({ length: 10 }, (_, s) => outfitKey(run(items, s + 1).candidates[0]!)));
    expect(firsts.size).toBeGreaterThan(5);
  });

  it("dresses and separates both show up in a mixed wardrobe", () => {
    const items = wardrobe({ top: 5, bottom: 5, dress_jumpsuit: 5, shoes: 3 });
    const { candidates } = run(items, 4);
    const cats = candidates.map((ids) => categoriesOf(ids, items));
    expect(cats.filter((c) => c.includes("dress_jumpsuit")).length).toBeGreaterThan(0);
    expect(cats.filter((c) => c.includes("top")).length).toBeGreaterThan(0);
  });
});

describe("QA candidates: formality spread (style coherence)", () => {
  it("never puts items more than 2 points apart in one candidate", () => {
    const rng = seededRandom(8);
    for (let i = 0; i < 30; i++) {
      const items = randomWardrobe(60, rng);
      const { candidates } = generateCandidates(items, { limit: MAX_CANDIDATES_SENT, random: rng });
      for (const ids of candidates) {
        const f = ids.map((id) => items.find((x) => x.id === id)!.tags.formality);
        expect(Math.max(...f) - Math.min(...f)).toBeLessThanOrEqual(2);
      }
    }
  });

  // Was FINDING (low), fixed: slots are first narrowed to items within the
  // formality spread of the required items, so the few coherent outfits
  // around an anchor are listed rather than sampled. Original finding:
  // above ENUMERATE_LIMIT combinations, candidates are found
  // by random draws (limit x 40 = 2,400). When only a handful of the
  // combinations are coherent around the anchor, the draws usually miss
  // them, and the pipeline answers "nothing_fits" although a valid,
  // coherent outfit exists. Realistic only for big wardrobes with a custom
  // style (no formality filter) and an anchor far from the rest.
  it("finds the one coherent outfit around a formal anchor in a big, mostly casual wardrobe", () => {
    const casual = wardrobe({ top: 150, bottom: 150 }, { formality: 1 });
    const smartTop = entry(1001, "top", { formality: 5 });
    const smartBottom = entry(1002, "bottom", { formality: 5 });
    const heels = entry(1003, "shoes", { subcategory: "heels", formality: 5 });
    const items = [...casual, smartTop, smartBottom, heels];
    const { candidates, combinations } = run(items, 1, { requiredIds: [heels.id] });
    expect(combinations).toBeGreaterThan(ENUMERATE_LIMIT);
    expect(candidates).toContainEqual([smartTop.id, smartBottom.id, heels.id]);
  });
});
