/**
 * Pipeline step 2: generate wearable outfits in code. Pure functions; the
 * randomness is passed in so tests are repeatable.
 *
 * A candidate is one body (a top and a bottom, or a dress or jumpsuit),
 * exactly one pair of shoes, and no outerwear or one piece of it: the
 * composition rule in checkComposition. Required items (the anchor, or the
 * items kept in a swap) fix their slot.
 *
 * Bounded for big wardrobes: combinations are numbered (a mixed-radix
 * index over body × shoes × outerwear), so a candidate can be built from
 * its number without listing the rest. Up to ENUMERATE_LIMIT combinations
 * are all listed; above that, random numbers are drawn. Either way at most
 * `limit` candidates come back.
 */
import { checkComposition, type Category } from "@/contracts";
import { ENUMERATE_LIMIT, MAX_FORMALITY_SPREAD, SAMPLE_ATTEMPTS_PER_CANDIDATE } from "./config";
import type { TaggedItem } from "./types";

export interface CandidateOptions {
  /** Items every candidate must include. Must be among `items`. */
  requiredIds?: readonly string[];
  /** Exact combinations to leave out: rejected outfits, the outfit being refined. */
  excludeOutfits?: readonly (readonly string[])[];
  /** Candidates containing one of these pairs go to the back of the list. */
  avoidPairs?: readonly (readonly [string, string])[];
  /** Most candidates to return. */
  limit: number;
  /** Returns a number in [0, 1), like Math.random. */
  random: () => number;
  maxFormalitySpread?: number;
}

export interface CandidateResult {
  /** Item IDs per candidate: body first, then shoes, then outerwear. */
  candidates: string[][];
  /** How many combinations the composition rule allows, before style coherence and exclusions. */
  combinations: number;
}

/** Order-independent key for a combination of items. */
export function outfitKey(itemIds: readonly string[]): string {
  return [...itemIds].sort().join("+");
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}+${b}` : `${b}+${a}`;
}

/** Every pair of items in an outfit. */
export function pairsOf(itemIds: readonly string[]): [string, string][] {
  const pairs: [string, string][] = [];
  for (let i = 0; i < itemIds.length; i++) {
    for (let j = i + 1; j < itemIds.length; j++) pairs.push([itemIds[i]!, itemIds[j]!]);
  }
  return pairs;
}

/**
 * "Avoid" hints from rejected outfits (newest first): each pair of items
 * that appeared together in one. Only pairs whose items are both in
 * `available` are kept (the model only sees those), without repeats, up to
 * `max`.
 */
export function avoidPairsFromRejected(
  rejectedOutfits: readonly (readonly string[])[],
  available: ReadonlySet<string>,
  max: number,
): [string, string][] {
  const seen = new Set<string>();
  const pairs: [string, string][] = [];
  for (const outfit of rejectedOutfits) {
    for (const [a, b] of pairsOf(outfit)) {
      if (!available.has(a) || !available.has(b)) continue;
      const key = pairKey(a, b);
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push([a, b]);
      if (pairs.length >= max) return pairs;
    }
  }
  return pairs;
}

interface Slots<T> {
  tops: T[];
  bottoms: T[];
  dresses: T[];
  shoes: T[];
  /** null = no outerwear. */
  outer: (T | null)[];
}

/**
 * The items available for each slot, with required items fixing theirs.
 * Null when the required items can't be in one outfit together.
 */
function slotsFor<T extends TaggedItem>(items: readonly T[], requiredIds: readonly string[], maxSpread: number): Slots<T> | null {
  const required = requiredIds.map((id) => items.find((i) => i.id === id));
  if (required.some((r) => r === undefined)) return null;
  const requiredItems = required as T[];

  // Every candidate contains the required items, so only items within
  // `maxSpread` of all of them can be in a coherent candidate. Pruning the
  // slots first means a combination around an anchor is never missed by
  // sampling: a formal anchor in a big casual wardrobe leaves few options,
  // which are then all listed.
  const levels = requiredItems.map((i) => i.tags.formality);
  const lowest = levels.length ? Math.max(...levels) - maxSpread : -Infinity;
  const highest = levels.length ? Math.min(...levels) + maxSpread : Infinity;
  const byCategory = (c: Category) =>
    items.filter((i) => i.tags.category === c && i.tags.formality >= lowest && i.tags.formality <= highest);
  const requiredOf = (c: Category) => requiredItems.filter((i) => i.tags.category === c);

  const fixed = {
    top: requiredOf("top"),
    bottom: requiredOf("bottom"),
    dress: requiredOf("dress_jumpsuit"),
    shoes: requiredOf("shoes"),
    outer: requiredOf("outerwear"),
  };
  if (Object.values(fixed).some((list) => list.length > 1)) return null;
  if (fixed.dress.length > 0 && (fixed.top.length > 0 || fixed.bottom.length > 0)) return null;

  const pick = (fixedList: T[], c: Category) => (fixedList.length > 0 ? fixedList : byCategory(c));
  const separatesAllowed = fixed.dress.length === 0;
  const onePieceAllowed = fixed.top.length === 0 && fixed.bottom.length === 0;

  return {
    tops: separatesAllowed ? pick(fixed.top, "top") : [],
    bottoms: separatesAllowed ? pick(fixed.bottom, "bottom") : [],
    dresses: onePieceAllowed ? pick(fixed.dress, "dress_jumpsuit") : [],
    shoes: pick(fixed.shoes, "shoes"),
    outer: fixed.outer.length > 0 ? fixed.outer : [null, ...byCategory("outerwear")],
  };
}

/** Number of combinations the slots allow. */
function combinationCount<T>(slots: Slots<T>): number {
  const bodies = slots.tops.length * slots.bottoms.length + slots.dresses.length;
  return bodies * slots.shoes.length * slots.outer.length;
}

/** Build combination number `index` (0 ≤ index < combinationCount). */
function combinationAt<T extends TaggedItem>(slots: Slots<T>, index: number): T[] {
  const outer = slots.outer[index % slots.outer.length]!;
  const rest = Math.floor(index / slots.outer.length);
  const shoes = slots.shoes[rest % slots.shoes.length]!;
  const bodyIndex = Math.floor(rest / slots.shoes.length);
  const separates = slots.tops.length * slots.bottoms.length;
  const body =
    bodyIndex < separates
      ? [slots.tops[Math.floor(bodyIndex / slots.bottoms.length)]!, slots.bottoms[bodyIndex % slots.bottoms.length]!]
      : [slots.dresses[bodyIndex - separates]!];
  return outer ? [...body, shoes, outer] : [...body, shoes];
}

function formalitySpread(items: readonly TaggedItem[]): number {
  const levels = items.map((i) => i.tags.formality);
  return Math.max(...levels) - Math.min(...levels);
}

/** Fisher–Yates shuffle using the given random source. Returns a new array. */
export function shuffle<T>(values: readonly T[], random: () => number): T[] {
  const result = [...values];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}

export function generateCandidates<T extends TaggedItem>(items: readonly T[], options: CandidateOptions): CandidateResult {
  const maxSpread = options.maxFormalitySpread ?? MAX_FORMALITY_SPREAD;
  const allSlots = slotsFor(items, options.requiredIds ?? [], Infinity);
  if (!allSlots) return { candidates: [], combinations: 0 };
  const combinations = combinationCount(allSlots);
  const slots = slotsFor(items, options.requiredIds ?? [], maxSpread)!;
  const coherentCombinations = combinationCount(slots);
  if (coherentCombinations === 0 || options.limit <= 0) return { candidates: [], combinations };

  const excluded = new Set((options.excludeOutfits ?? []).map(outfitKey));
  const avoid = new Set((options.avoidPairs ?? []).map(([a, b]) => pairKey(a, b)));

  const acceptable = (combo: T[]) =>
    formalitySpread(combo) <= maxSpread && !excluded.has(outfitKey(combo.map((i) => i.id)));
  const hasAvoidPair = (ids: string[]) => pairsOf(ids).some(([a, b]) => avoid.has(pairKey(a, b)));

  // Combination numbers to consider, in random order.
  let order: Iterable<number>;
  if (coherentCombinations <= ENUMERATE_LIMIT) {
    order = shuffle(
      Array.from({ length: coherentCombinations }, (_, i) => i),
      options.random,
    );
  } else {
    order = randomDraws(coherentCombinations, options.limit * SAMPLE_ATTEMPTS_PER_CANDIDATE, options.random);
  }

  const clean: string[][] = [];
  const withAvoidPair: string[][] = [];
  for (const index of order) {
    const combo = combinationAt(slots, index);
    if (!acceptable(combo)) continue;
    const ids = combo.map((i) => i.id);
    (hasAvoidPair(ids) ? withAvoidPair : clean).push(ids);
    if (clean.length >= options.limit) break;
  }

  const candidates = [...clean, ...withAvoidPair].slice(0, options.limit);
  // Belt and braces: generation must only ever produce wearable outfits.
  for (const ids of candidates) {
    const categories = ids.map((id) => items.find((i) => i.id === id)!.tags.category);
    if (!checkComposition(categories).ok) throw new Error(`Generated an invalid outfit: ${ids.join(", ")}`);
  }
  return { candidates, combinations };
}

/** Up to `attempts` distinct random numbers in [0, total). */
function* randomDraws(total: number, attempts: number, random: () => number): Generator<number> {
  const seen = new Set<number>();
  for (let i = 0; i < attempts; i++) {
    const index = Math.floor(random() * total);
    if (seen.has(index)) continue;
    seen.add(index);
    yield index;
  }
}

/** A small seeded random source (mulberry32), for repeatable tests. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
