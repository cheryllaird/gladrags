import { describe, expect, it } from "vitest";
import { checkComposition, type Category } from "@/contracts";
import { entry, randomWardrobe, wardrobe } from "@/test/outfit-helpers";
import {
  avoidPairsFromRejected,
  generateCandidates,
  outfitKey,
  pairsOf,
  seededRandom,
  shuffle,
} from "./candidates";
import { MAX_CANDIDATES_SENT } from "./config";
import type { WardrobeEntry } from "./types";

const random = () => seededRandom(1);

function categoriesOf(ids: string[], items: WardrobeEntry[]): Category[] {
  return ids.map((id) => items.find((i) => i.id === id)!.tags.category);
}

function expectAllWearable(candidates: string[][], items: WardrobeEntry[]) {
  for (const ids of candidates) expect(checkComposition(categoriesOf(ids, items))).toEqual({ ok: true });
}

describe("generateCandidates: composition", () => {
  it("lists every top + bottom + shoes combination, with and without outerwear", () => {
    const items = wardrobe({ top: 2, bottom: 2, shoes: 1, outerwear: 1 });
    const { candidates, combinations } = generateCandidates(items, { limit: 100, random: random() });
    expect(combinations).toBe(2 * 2 * 1 * 2);
    expect(candidates).toHaveLength(8);
    expect(new Set(candidates.map(outfitKey)).size).toBe(8);
    expectAllWearable(candidates, items);
  });

  it("uses a dress or jumpsuit as the whole body", () => {
    const items = wardrobe({ dress_jumpsuit: 2, shoes: 2 });
    const { candidates } = generateCandidates(items, { limit: 100, random: random() });
    expect(candidates).toHaveLength(4);
    expectAllWearable(candidates, items);
    for (const ids of candidates) expect(ids).toHaveLength(2);
  });

  it("never puts a dress with a top or bottom, or two of anything", () => {
    const items = wardrobe({ top: 3, bottom: 3, dress_jumpsuit: 3, shoes: 3, outerwear: 3 });
    const { candidates } = generateCandidates(items, { limit: 1000, random: random() });
    expect(candidates).toHaveLength((3 * 3 + 3) * 3 * 4);
    expectAllWearable(candidates, items);
  });

  it("returns nothing without shoes, or without a body", () => {
    expect(generateCandidates(wardrobe({ top: 2, bottom: 2 }), { limit: 10, random: random() }).candidates).toEqual([]);
    expect(generateCandidates(wardrobe({ top: 2, shoes: 2 }), { limit: 10, random: random() }).candidates).toEqual([]);
    expect(generateCandidates([], { limit: 10, random: random() }).candidates).toEqual([]);
  });

  it("respects the limit", () => {
    const items = wardrobe({ top: 5, bottom: 5, shoes: 5, outerwear: 3 });
    const { candidates, combinations } = generateCandidates(items, { limit: 7, random: random() });
    expect(combinations).toBe(5 * 5 * 5 * 4);
    expect(candidates).toHaveLength(7);
  });

  it("is repeatable with the same random seed, and varies with another", () => {
    const items = wardrobe({ top: 5, bottom: 5, shoes: 5, outerwear: 3 });
    const a = generateCandidates(items, { limit: 10, random: seededRandom(5) }).candidates;
    const b = generateCandidates(items, { limit: 10, random: seededRandom(5) }).candidates;
    const c = generateCandidates(items, { limit: 10, random: seededRandom(6) }).candidates;
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });
});

describe("generateCandidates: required items", () => {
  const items = wardrobe({ top: 2, bottom: 2, dress_jumpsuit: 1, shoes: 2, outerwear: 1 });
  const [top] = items.filter((i) => i.tags.category === "top");
  const [bottom] = items.filter((i) => i.tags.category === "bottom");
  const [dress] = items.filter((i) => i.tags.category === "dress_jumpsuit");
  const [shoe] = items.filter((i) => i.tags.category === "shoes");
  const [coat] = items.filter((i) => i.tags.category === "outerwear");

  it.each([
    ["top", top!],
    ["bottom", bottom!],
    ["dress", dress!],
    ["shoes", shoe!],
    ["outerwear", coat!],
  ])("includes a required %s in every candidate", (_label, anchor) => {
    const { candidates } = generateCandidates(items, { requiredIds: [anchor.id], limit: 100, random: random() });
    expect(candidates.length).toBeGreaterThan(0);
    for (const ids of candidates) expect(ids).toContain(anchor.id);
    expectAllWearable(candidates, items);
  });

  it("a required top means separates only (no dress)", () => {
    const { candidates } = generateCandidates(items, { requiredIds: [top!.id], limit: 100, random: random() });
    for (const ids of candidates) expect(ids).not.toContain(dress!.id);
    expect(candidates).toHaveLength(2 * 2 * 2); // bottoms × shoes × (none | coat)
  });

  it("a required outerwear is in every candidate (no 'without outerwear' option)", () => {
    const { candidates } = generateCandidates(items, { requiredIds: [coat!.id], limit: 100, random: random() });
    expect(candidates).toHaveLength((2 * 2 + 1) * 2);
  });

  it("keeps several required items together (a swap keeps the rest of the outfit)", () => {
    const { candidates } = generateCandidates(items, { requiredIds: [top!.id, bottom!.id], limit: 100, random: random() });
    for (const ids of candidates) expect(ids).toEqual(expect.arrayContaining([top!.id, bottom!.id]));
    expect(candidates).toHaveLength(2 * 2);
  });

  it("returns nothing for required items that can't be worn together", () => {
    const tops = items.filter((i) => i.tags.category === "top");
    expect(generateCandidates(items, { requiredIds: tops.map((t) => t.id), limit: 10, random: random() }).candidates).toEqual([]);
    expect(generateCandidates(items, { requiredIds: [top!.id, dress!.id], limit: 10, random: random() }).candidates).toEqual([]);
  });

  it("returns nothing for a required item that isn't available", () => {
    expect(generateCandidates(items, { requiredIds: ["nope"], limit: 10, random: random() }).candidates).toEqual([]);
  });
});

describe("generateCandidates: style and feedback", () => {
  it("leaves out combinations whose formality is too far apart", () => {
    const items = [
      entry(1, "top", { formality: 1 }),
      entry(2, "bottom", { formality: 1 }),
      entry(3, "shoes", { formality: 3 }),
      entry(4, "shoes", { formality: 4 }),
    ];
    const { candidates, combinations } = generateCandidates(items, { limit: 10, random: random() });
    expect(combinations).toBe(2);
    expect(candidates).toEqual([[items[0]!.id, items[1]!.id, items[2]!.id]]);
  });

  it("leaves out excluded combinations whatever their order", () => {
    const items = wardrobe({ top: 1, bottom: 1, shoes: 2 });
    const [t, b, s1, s2] = items.map((i) => i.id) as [string, string, string, string];
    const { candidates } = generateCandidates(items, { excludeOutfits: [[s1, b, t]], limit: 10, random: random() });
    expect(candidates).toEqual([[t, b, s2]]);
  });

  it("puts candidates with an avoid pair at the back", () => {
    const items = wardrobe({ top: 2, bottom: 1, shoes: 1 });
    const [t1, t2, b] = items.map((i) => i.id) as [string, string, string];
    for (const seed of [1, 2, 3, 4]) {
      const { candidates } = generateCandidates(items, { avoidPairs: [[b, t1]], limit: 10, random: seededRandom(seed) });
      expect(candidates[0]).toContain(t2);
      expect(candidates[1]).toContain(t1);
    }
  });
});

describe("generateCandidates: big wardrobes stay bounded", () => {
  it("handles 200 items quickly and returns at most the limit, all wearable", () => {
    const items = randomWardrobe(200, seededRandom(99));
    const started = performance.now();
    const { candidates, combinations } = generateCandidates(items, { limit: MAX_CANDIDATES_SENT, random: random() });
    const elapsed = performance.now() - started;
    expect(combinations).toBeGreaterThan(100_000); // far too many to list
    expect(candidates).toHaveLength(MAX_CANDIDATES_SENT);
    expect(new Set(candidates.map(outfitKey)).size).toBe(candidates.length);
    expectAllWearable(candidates, items);
    expect(elapsed).toBeLessThan(500);
  });

  it("samples big wardrobes with required items too", () => {
    const items = randomWardrobe(200, seededRandom(3));
    const anchor = items.find((i) => i.tags.category === "shoes" && i.tags.formality === 3)!;
    const { candidates } = generateCandidates(items, { requiredIds: [anchor.id], limit: 30, random: random() });
    expect(candidates).toHaveLength(30);
    for (const ids of candidates) expect(ids).toContain(anchor.id);
    expectAllWearable(candidates, items);
  });

  it("generates only wearable outfits for many random wardrobes", () => {
    const rng = seededRandom(2026);
    for (let run = 0; run < 50; run++) {
      const items = randomWardrobe(1 + Math.floor(rng() * 40), rng);
      const { candidates } = generateCandidates(items, { limit: 20, random: rng });
      expectAllWearable(candidates, items);
    }
  });
});

describe("helpers", () => {
  it("pairsOf lists each pair once", () => {
    expect(pairsOf(["a", "b", "c"])).toEqual([
      ["a", "b"],
      ["a", "c"],
      ["b", "c"],
    ]);
  });

  it("avoidPairsFromRejected keeps available, unique pairs up to the limit, newest first", () => {
    const pairs = avoidPairsFromRejected(
      [
        ["a", "b", "c"],
        ["b", "a", "x"],
      ],
      new Set(["a", "b", "c"]),
      10,
    );
    expect(pairs).toEqual([
      ["a", "b"],
      ["a", "c"],
      ["b", "c"],
    ]);
    expect(avoidPairsFromRejected([["a", "b", "c"]], new Set(["a", "b", "c"]), 2)).toHaveLength(2);
  });

  it("shuffle keeps every value", () => {
    expect(shuffle([1, 2, 3, 4, 5], seededRandom(1)).sort()).toEqual([1, 2, 3, 4, 5]);
  });
});
