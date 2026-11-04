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
 *
 * Gaps (milestone 5): a slot the wardrobe can't fill, or one shop item when
 * the request asks for it, becomes a gap the model describes.
 * generateGapCandidates lists these outfits by "slot pattern" (which slots
 * are owned and which are gaps), keeping only patterns the shared
 * checkRankedOutfits would accept, so code and validation agree on what a
 * gap may be. generateOutfitCandidates puts complete outfits first.
 */
import { checkComposition, checkRankedOutfits, type Category, type GapRules } from "@/contracts";
import { ENUMERATE_LIMIT, GAP_CANDIDATE_SHARE, MAX_FORMALITY_SPREAD, SAMPLE_ATTEMPTS_PER_CANDIDATE } from "./config";
import type { TaggedItem } from "./types";

export interface CandidateOptions {
  /** Items every candidate must include. Must be among `items`. */
  requiredIds?: readonly string[];
  /**
   * Exact combinations to leave out: rejected outfits, the outfit being
   * refined. A bare list of item IDs is a complete outfit.
   */
  excludeOutfits?: readonly OutfitShape[];
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

/** A candidate outfit: owned items plus the slots left as gaps. */
export interface Candidate {
  /** Owned items: body first, then shoes, then outerwear. */
  itemIds: string[];
  /** Categories of the slots left as gaps. Empty for a complete outfit. */
  gaps: Category[];
}

/**
 * An outfit's shape, for leaving it out or matching it: owned items and gap
 * slots. A bare list of item IDs is a complete outfit (no gaps).
 */
export type OutfitShape = readonly string[] | { readonly itemIds: readonly string[]; readonly gaps?: readonly Category[] };

/** The item IDs and gap categories of a shape. */
export function shapeParts(shape: OutfitShape): { itemIds: readonly string[]; gaps: readonly Category[] } {
  return "itemIds" in shape ? { itemIds: shape.itemIds, gaps: shape.gaps ?? [] } : { itemIds: shape, gaps: [] };
}

/**
 * Order-independent key for an outfit's shape. Two outfits with the same
 * items but different gap slots are different outfits. For a complete
 * outfit it's the same as outfitKey.
 */
export function shapeKey(shape: OutfitShape): string {
  const { itemIds, gaps } = shapeParts(shape);
  const key = outfitKey(itemIds);
  return gaps.length > 0 ? `${key}|gaps:${[...gaps].sort().join("+")}` : key;
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
function combinationAt<T>(slots: Slots<T>, index: number): T[] {
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

  const excluded = new Set((options.excludeOutfits ?? []).map(shapeKey));
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

// ---------------------------------------------------------------------------
// Gaps
// ---------------------------------------------------------------------------

/** A gap in a slot, standing in for an item in the slot lists. */
interface GapMark {
  gap: Category;
}

function isGap<T>(entry: T | GapMark): entry is GapMark {
  return typeof entry === "object" && entry !== null && "gap" in entry;
}

type SlotFill = "own" | "gap";

/**
 * Which slots of one outfit are owned and which are gaps. Outerwear is
 * optional: `null` means none.
 */
type SlotPattern =
  | { body: "separates"; top: SlotFill; bottom: SlotFill; shoes: SlotFill; outer: SlotFill | null }
  | { body: "onepiece"; dress: SlotFill; shoes: SlotFill; outer: SlotFill | null };

/** Every slot pattern, as (category, fill) pairs. */
function patternSlots(p: SlotPattern): [Category, SlotFill][] {
  const body: [Category, SlotFill][] = p.body === "separates" ? [["top", p.top], ["bottom", p.bottom]] : [["dress_jumpsuit", p.dress]];
  return [...body, ["shoes", p.shoes], ...(p.outer ? [["outerwear", p.outer] as [Category, SlotFill]] : [])];
}

function allPatterns(): SlotPattern[] {
  const fills: SlotFill[] = ["own", "gap"];
  const outers: (SlotFill | null)[] = [null, "own", "gap"];
  const patterns: SlotPattern[] = [];
  for (const outer of outers) {
    for (const shoes of fills) {
      for (const top of fills) for (const bottom of fills) patterns.push({ body: "separates", top, bottom, shoes, outer });
      for (const dress of fills) patterns.push({ body: "onepiece", dress, shoes, outer });
    }
  }
  return patterns;
}

export interface GapCandidateOptions extends CandidateOptions {
  /** Which gaps are allowed: the same rules checkRankedOutfits applies to the model's picks. */
  gapRules: GapRules;
  /** The request's anchor item (always owned), if any. Should also be in requiredIds. */
  anchorItemId?: string | null;
}

/**
 * Whether checkRankedOutfits would accept an outfit with these owned and
 * gap categories. Gap rules depend only on categories (which slots are
 * owned, which are gaps, the anchor's category), so the check runs on
 * stand-in IDs, one per owned slot.
 */
function patternAllowed(
  owned: readonly Category[],
  gaps: readonly Category[],
  rules: GapRules,
  anchorCategory: Category | undefined,
): boolean {
  const known = new Map(owned.map((c) => [`own:${c}`, c] as const));
  const outfit = { itemIds: [...known.keys()], gaps: gaps.map((category) => ({ category })) };
  const anchorItemId = anchorCategory ? `own:${anchorCategory}` : undefined;
  return checkRankedOutfits([outfit], known, { anchorItemId, gaps: rules }).valid.length === 1;
}

/**
 * Outfits with at least one gap and at least one owned item, as allowed by
 * `gapRules`: a required slot the (filtered) wardrobe can't fill, and with
 * includeShopItems at most one slot it could. Complete outfits are left out
 * (generateCandidates lists those). Fewer gaps come first, and patterns
 * with the same number of gaps take turns, so one kind of gap doesn't crowd
 * out the rest. At most `limit`.
 */
export function generateGapCandidates<T extends TaggedItem>(items: readonly T[], options: GapCandidateOptions): Candidate[] {
  const maxSpread = options.maxFormalitySpread ?? MAX_FORMALITY_SPREAD;
  const requiredIds = options.requiredIds ?? [];
  const base = slotsFor(items, requiredIds, maxSpread);
  if (!base || options.limit <= 0) return [];
  const requiredCategories = requiredIds.map((id) => items.find((i) => i.id === id)!.tags.category);
  const anchorCategory = options.anchorItemId ? items.find((i) => i.id === options.anchorItemId)?.tags.category : undefined;

  const excluded = new Set((options.excludeOutfits ?? []).map(shapeKey));
  const avoid = new Set((options.avoidPairs ?? []).map(([a, b]) => pairKey(a, b)));
  const ownedLists: Record<Category, T[]> = {
    top: base.tops,
    bottom: base.bottoms,
    dress_jumpsuit: base.dresses,
    shoes: base.shoes,
    outerwear: base.outer.filter((o): o is T => o !== null),
  };

  // Each allowed pattern's candidates, grouped by number of gaps.
  const byGapCount = new Map<number, { clean: Candidate[]; withAvoidPair: Candidate[] }[]>();
  for (const pattern of allPatterns()) {
    const slots = patternSlots(pattern);
    const owned = slots.filter(([, fill]) => fill === "own").map(([c]) => c);
    const gaps = slots.filter(([, fill]) => fill === "gap").map(([c]) => c);
    if (gaps.length === 0 || owned.length === 0) continue;
    // Every required item needs an owned slot of its category.
    if (requiredCategories.some((c) => !owned.includes(c))) continue;
    if (!patternAllowed(owned, gaps, options.gapRules, anchorCategory)) continue;

    const list = (c: Category, fill: SlotFill | null): (T | GapMark | null)[] =>
      fill === null ? [null] : fill === "gap" ? [{ gap: c }] : ownedLists[c];
    const patternSlotsList: Slots<T | GapMark | null> =
      pattern.body === "separates"
        ? { tops: list("top", pattern.top), bottoms: list("bottom", pattern.bottom), dresses: [], shoes: list("shoes", pattern.shoes), outer: list("outerwear", pattern.outer) }
        : { tops: [], bottoms: [], dresses: list("dress_jumpsuit", pattern.dress), shoes: list("shoes", pattern.shoes), outer: list("outerwear", pattern.outer) };
    const total = combinationCount(patternSlotsList);
    if (total === 0) continue;

    const order: Iterable<number> =
      total <= ENUMERATE_LIMIT
        ? shuffle(Array.from({ length: total }, (_, i) => i), options.random)
        : randomDraws(total, options.limit * SAMPLE_ATTEMPTS_PER_CANDIDATE, options.random);
    const found = { clean: [] as Candidate[], withAvoidPair: [] as Candidate[] };
    for (const index of order) {
      const combo = combinationAt(patternSlotsList, index).filter((e): e is T | GapMark => e !== null);
      const ownedItems = combo.filter((e): e is T => !isGap(e));
      const candidate: Candidate = { itemIds: ownedItems.map((i) => i.id), gaps: combo.filter(isGap).map((g) => g.gap) };
      if (formalitySpread(ownedItems) > maxSpread || excluded.has(shapeKey(candidate))) continue;
      const hasAvoid = pairsOf(candidate.itemIds).some(([a, b]) => avoid.has(pairKey(a, b)));
      (hasAvoid ? found.withAvoidPair : found.clean).push(candidate);
      if (found.clean.length >= options.limit) break;
    }
    const group = byGapCount.get(gaps.length) ?? [];
    group.push(found);
    byGapCount.set(gaps.length, group);
  }

  const clean: Candidate[] = [];
  const withAvoidPair: Candidate[] = [];
  for (const gapCount of [...byGapCount.keys()].sort((a, b) => a - b)) {
    const group = byGapCount.get(gapCount)!;
    clean.push(...roundRobin(group.map((g) => g.clean)));
    withAvoidPair.push(...roundRobin(group.map((g) => g.withAvoidPair)));
  }
  const candidates = [...clean, ...withAvoidPair].slice(0, options.limit);

  // Belt and braces: every gap candidate must pass the same check as the model's picks.
  const known = new Map(items.map((i) => [i.id, i.tags.category] as const));
  const check = checkRankedOutfits(
    candidates.map((c) => ({ itemIds: c.itemIds, gaps: c.gaps.map((category) => ({ category })) })),
    known,
    { anchorItemId: options.anchorItemId ?? undefined, gaps: options.gapRules },
  );
  if (check.rejected.length > 0) {
    throw new Error(`Generated an invalid gap outfit: ${check.rejected.map((r) => r.problem).join("; ")}`);
  }
  return candidates;
}

/** Interleave lists: first of each, then second of each, and so on. */
function roundRobin<T>(lists: readonly T[][]): T[] {
  const result: T[] = [];
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < longest; i++) for (const list of lists) if (i < list.length) result.push(list[i]!);
  return result;
}

export interface OutfitCandidateResult {
  candidates: Candidate[];
  /** How many of `candidates` are complete outfits from the wardrobe (they come first). */
  complete: number;
}

/**
 * Pipeline step 2 with gaps: complete outfits first (spec: "complete
 * outfits from the wardrobe are preferred"), then outfits with gaps. When
 * there are gap candidates, they keep at least GAP_CANDIDATE_SHARE of the
 * places, so a wardrobe with plenty of complete outfits still offers the
 * model a top without bottoms (with a bottom gap), or the shop item the user
 * asked for.
 */
export function generateOutfitCandidates<T extends TaggedItem>(items: readonly T[], options: GapCandidateOptions): OutfitCandidateResult {
  const complete = generateCandidates(items, options).candidates.map((itemIds): Candidate => ({ itemIds, gaps: [] }));
  const gapped = generateGapCandidates(items, options);
  const reserved = Math.min(gapped.length, Math.ceil(options.limit * GAP_CANDIDATE_SHARE));
  const takenComplete = complete.slice(0, Math.max(0, options.limit - reserved));
  const candidates = [...takenComplete, ...gapped.slice(0, options.limit - takenComplete.length)];
  return { candidates, complete: takenComplete.length };
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
