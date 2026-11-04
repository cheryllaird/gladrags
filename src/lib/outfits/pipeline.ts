/**
 * The outfit pipeline (spec: "Outfit suggestions → Pipeline"):
 *
 *   filter → candidates in code → pass 1 on tags (shortlist ~8)
 *     → pass 2 with ~256 px thumbnails (best N, named) → validate
 *
 * It has no database or HTTP code: the service loads the wardrobe and
 * saves the result. Everything it needs is passed in, so tests run it with
 * fake providers and recorded replies.
 */
import type { z } from "zod";
import {
  OUTFIT_COUNT,
  RankingFinalOutputSchema,
  RankingShortlistOutputSchema,
  SHORTLIST_MAX,
  missingCategoriesForOutfits,
  type AiCostKind,
  type Category,
  type GapDescription,
  type GapRules,
  type StyleChoice,
} from "@/contracts";
import type { ModelCall, RankingContext, RankingProvider } from "@/lib/ai/types";
import { callWithValidation } from "@/lib/ai/validate";
import { ApiException } from "@/lib/api/errors";
import { avoidPairsFromRejected, generateOutfitCandidates, shapeParts, type Candidate, type OutfitShape } from "./candidates";
import { MAX_AVOID_PAIRS, MAX_CANDIDATES_SENT, SHORTLIST_SIZE } from "./config";
import { FILTER_LEVELS, filterItems } from "./filter";
import { seasonAt } from "./season";
import type { ThumbnailSource } from "./thumbnails";
import type { RankedOutfit, WardrobeEntry } from "./types";
import { RankingReplyEnvelopeSchema, checkReply, type CheckableOutfit, type OutfitRules } from "./validate";

export interface PipelineDeps {
  /** Makes the ranking provider; called only once the model is needed. */
  ranking: () => RankingProvider;
  thumbnails: ThumbnailSource;
  /**
   * Before each model call (every attempt): reserve its estimated cost
   * against the monthly AI cap. Throws CapReachedError (ai_paused) if the
   * cap is reached, which stops the pipeline.
   */
  beforeAiCall: (kind: Extract<AiCostKind, "ranking_shortlist" | "ranking_final">) => Promise<void>;
  /** Record one model call's cost (every attempt, including failed ones). */
  recordAiCost: (kind: Extract<AiCostKind, "ranking_shortlist" | "ranking_final">, call: ModelCall) => Promise<void>;
  /**
   * Called once, just before the first model call. The service counts the
   * outfit request against the daily cap here, so a request that ends at
   * "incomplete wardrobe" (no AI used) isn't counted.
   */
  onRankingStart: () => Promise<void>;
  /** Random source for sampling candidates. */
  random: () => number;
  now: () => Date;
}

export interface PipelineInput {
  /** The user's wardrobe, minus anything this request mustn't use (a swapped-out item). */
  items: readonly WardrobeEntry[];
  style: StyleChoice;
  guidance: string | null;
  anchorItemId: string | null;
  /** "Include items from my shops": outfits may have one shop-item gap. Missing means false. */
  includeShopItems?: boolean;
  /** How many outfits to return. */
  count: number;
  /** Swap refinement: the outfit's other items, kept if possible. */
  keepItemIds?: readonly string[];
  /**
   * Outfits the user rejected, newest first: their item pairs become
   * "avoid" hints, and the exact outfits aren't offered again.
   */
  rejectedOutfits: readonly OutfitShape[];
  /** Exact outfits not to suggest again (the outfit being refined). */
  excludeOutfits?: readonly OutfitShape[];
  /**
   * Outfits to leave out only if anything else is possible: a guidance
   * refinement of an outfit with gaps. With a sparse wardrobe the same
   * owned items and gap slots may be all there is, and new gap
   * descriptions are then the revision.
   */
  softExcludeOutfits?: readonly OutfitShape[];
  refinement?: RankingContext["refinement"];
}

export type PipelineResult =
  | {
      status: "ok";
      outfits: RankedOutfit[];
      /** Categories the wardrobe is missing for this request (their slots became gaps). */
      missingCategories: Category[];
    }
  | { status: "incomplete_wardrobe"; reason: "empty_wardrobe" | "nothing_fits"; missingCategories: [] };

interface Choice {
  requiredIds: string[];
  items: WardrobeEntry[];
  candidates: Candidate[];
  complete: number;
  avoidPairs: [string, string][];
  gapRules: GapRules;
}

/**
 * Required items to try, in order. A swap first tries to keep the outfit's
 * other items, then lets them go (keeping the anchor).
 */
function requiredSetsFor(input: PipelineInput): string[][] {
  const anchor = input.anchorItemId ? [input.anchorItemId] : [];
  const keep = [...new Set([...anchor, ...(input.keepItemIds ?? [])])];
  return keep.length > anchor.length ? [keep, anchor] : [anchor];
}

/**
 * Of the filter levels tried (strictest first), the one to use. Complete
 * outfits come first: the strictest level with at least `count` complete
 * candidates. Failing that, among the levels with the most complete
 * candidates, the strictest with at least `count` candidates in all, else
 * the one with the most.
 */
function pickLevel(results: readonly Choice[], count: number): Choice | null {
  const usable = results.filter((r) => r.candidates.length > 0);
  if (usable.length === 0) return null;
  const enoughComplete = usable.find((r) => r.complete >= count);
  if (enoughComplete) return enoughComplete;
  const mostComplete = Math.max(...usable.map((r) => r.complete));
  const best = usable.filter((r) => r.complete === mostComplete);
  return best.find((r) => r.candidates.length >= count) ?? best.reduce((a, b) => (b.candidates.length > a.candidates.length ? b : a));
}

function aiFailed(): ApiException {
  return new ApiException("ai_failed", "We couldn't put outfits together just now. Please try again.");
}

export async function runOutfitPipeline(input: PipelineInput, deps: PipelineDeps): Promise<PipelineResult> {
  // No items at all: no outfit can have an owned piece.
  if (input.items.length === 0) return { status: "incomplete_wardrobe", reason: "empty_wardrobe", missingCategories: [] };

  const byId = new Map(input.items.map((item) => [item.id, item]));
  const anchor = input.anchorItemId ? byId.get(input.anchorItemId) : undefined;
  if (input.anchorItemId && !anchor) throw new Error("The anchor item must be in the wardrobe");
  const includeShopItems = input.includeShopItems ?? false;

  // Steps 1 and 2: filter, then generate candidates (complete outfits
  // first, then outfits with gaps). For each set of required items, try
  // each filter level and pick one (pickLevel); use the first set of
  // required items that gives any.
  const season = seasonAt(deps.now());
  const rejectedItemIds = input.rejectedOutfits.map((o) => shapeParts(o).itemIds);
  const chooseCandidates = (excludeOutfits: readonly OutfitShape[]): Choice | null => {
    for (const requiredIds of requiredSetsFor(input)) {
      const tried: Choice[] = [];
      for (const level of FILTER_LEVELS) {
        const filtered = filterItems(input.items, { style: input.style, season, ...level, keepIds: new Set(requiredIds) });
        const avoidPairs = avoidPairsFromRejected(rejectedItemIds, new Set(filtered.map((i) => i.id)), MAX_AVOID_PAIRS);
        // Gaps are judged against what this request could use: the filtered wardrobe.
        const gapRules: GapRules = { fillableCategories: new Set(filtered.map((i) => i.tags.category)), includeShopItems };
        const { candidates, complete } = generateOutfitCandidates(filtered, {
          requiredIds,
          anchorItemId: input.anchorItemId,
          excludeOutfits,
          avoidPairs,
          gapRules,
          limit: MAX_CANDIDATES_SENT,
          random: deps.random,
        });
        tried.push({ requiredIds, items: filtered, candidates, complete, avoidPairs, gapRules });
        if (complete >= input.count) break;
      }
      const picked = pickLevel(tried, input.count);
      if (picked) return picked;
    }
    return null;
  };

  // Rejected outfits and `excludeOutfits` are always left out; soft
  // exclusions only while something else is possible.
  const hardExcluded = [...input.rejectedOutfits, ...(input.excludeOutfits ?? [])];
  const soft = input.softExcludeOutfits ?? [];
  let excludeOutfits: readonly OutfitShape[] = soft.length > 0 ? [...hardExcluded, ...soft] : hardExcluded;
  let chosen = chooseCandidates(excludeOutfits);
  if (!chosen && soft.length > 0) {
    excludeOutfits = hardExcluded;
    chosen = chooseCandidates(excludeOutfits);
  }
  if (!chosen) return { status: "incomplete_wardrobe", reason: "nothing_fits", missingCategories: [] };

  const { requiredIds, items, candidates, avoidPairs, gapRules } = chosen;
  const missingCategories = missingCategoriesForOutfits(gapRules.fillableCategories, anchor?.tags.category);
  const context: RankingContext = {
    request: {
      style: input.style,
      anchorItemId: input.anchorItemId ?? undefined,
      guidance: input.guidance ?? undefined,
      includeShopItems,
    },
    avoidPairs,
    refinement: input.refinement,
  };
  const rulesFor = (known: readonly WardrobeEntry[], allowedOutfits: OutfitShape[]): OutfitRules => ({
    known: new Map<string, Category>(known.map((i) => [i.id, i.tags.category])),
    anchorItemId: input.anchorItemId,
    requiredIds,
    excludeOutfits,
    allowedOutfits,
    gaps: gapRules,
  });

  // Created only now, so an incomplete wardrobe never needs the model, and
  // a missing API key (ConfigError) surfaces before the request is counted
  // rather than looking like a failed model call.
  const ranking = deps.ranking();
  await deps.onRankingStart();

  // Step 3a: shortlist on tags. With only a few candidates there's nothing
  // to shortlist, so pass 1 is skipped and they all go to pass 2.
  let shortlist: { itemIds: string[]; gaps: { category: Category; suggestion?: GapDescription }[] }[];
  if (candidates.length <= SHORTLIST_SIZE) {
    shortlist = candidates.map((c) => ({ itemIds: c.itemIds, gaps: c.gaps.map((category) => ({ category })) }));
  } else {
    // Only items that appear in a candidate (plus required ones) are sent.
    const offeredIds = new Set([...candidates.flatMap((c) => c.itemIds), ...requiredIds]);
    const offered = items.filter((i) => offeredIds.has(i.id));
    const picks = await rankPass({
      schema: SHORTLIST_OUTFIT_SCHEMA,
      max: SHORTLIST_MAX,
      rules: rulesFor(offered, candidates),
      enough: shortlistEnough(input.count),
      call: () =>
        ranking.shortlist({
          ...context,
          items: offered.map(({ id, tags }) => ({ id, tags })),
          candidates,
          shortlistSize: SHORTLIST_SIZE,
        }),
      beforeCall: () => deps.beforeAiCall("ranking_shortlist"),
      onCall: (call) => deps.recordAiCost("ranking_shortlist", call),
      provider: ranking.name,
    });
    shortlist = picks.map((o) => ({ itemIds: o.itemIds, gaps: (o.gaps ?? []).map((g) => ({ category: g.category, suggestion: g })) }));
  }

  // Step 3b: pick the best N, looking at thumbnails of the shortlisted
  // items (those with a picture).
  const shortlistIds = [...new Set(shortlist.flatMap((o) => o.itemIds))];
  const shortlistItems = shortlistIds.map((id) => byId.get(id)!);
  const thumbnails = await deps.thumbnails.getThumbnails(shortlistItems);
  const picked = await rankPass({
    schema: FINAL_OUTFIT_SCHEMA,
    max: OUTFIT_COUNT.max,
    rules: rulesFor(
      shortlistItems,
      shortlist.map((o) => ({ itemIds: o.itemIds, gaps: o.gaps.map((g) => g.category) })),
    ),
    enough: input.count,
    call: () =>
      ranking.pickFinal({
        ...context,
        items: shortlistItems.map(({ id, tags }) => ({ id, tags })),
        shortlist: shortlist.map(({ itemIds, gaps }) => ({
          itemIds,
          gaps,
          thumbnails: itemIds.flatMap((itemId) => {
            const image = thumbnails.get(itemId);
            return image ? [{ itemId, image }] : [];
          }),
        })),
        count: input.count,
      }),
    beforeCall: () => deps.beforeAiCall("ranking_final"),
    onCall: (call) => deps.recordAiCost("ranking_final", call),
    provider: ranking.name,
  });
  const ranked = picked.map((o): RankedOutfit => ({ itemIds: o.itemIds, gaps: o.gaps ?? [], name: o.name, reason: o.reason }));
  return { status: "ok", outfits: completeFirst(ranked, input.count, includeShopItems), missingCategories };
}

/**
 * The final order: complete outfits first (a stable sort keeps the
 * model's order otherwise), cut to `count`. With "Include items from my
 * shops" on, the cut never drops every outfit with a gap: the model's best
 * one takes the last place, so the shop item the user asked for is shown.
 */
export function completeFirst(ranked: readonly RankedOutfit[], count: number, includeShopItems: boolean): RankedOutfit[] {
  const outfits = [...ranked].sort((a, b) => a.gaps.length - b.gaps.length).slice(0, count);
  if (includeShopItems && outfits.length > 0 && !outfits.some((o) => o.gaps.length > 0)) {
    const bestWithGap = ranked.find((o) => o.gaps.length > 0);
    if (bestWithGap) return [...outfits.slice(0, count - 1), bestWithGap];
  }
  return outfits;
}

/** The contract's schema for one outfit in each pass's reply. */
const SHORTLIST_OUTFIT_SCHEMA = RankingShortlistOutputSchema.shape.outfits.element;
const FINAL_OUTFIT_SCHEMA = RankingFinalOutputSchema.shape.outfits.element;

/**
 * Valid shortlisted outfits that make pass 1 good enough without a retry:
 * a little more than the final count, so pass 2 still has a choice.
 */
export function shortlistEnough(count: number): number {
  return Math.min(SHORTLIST_SIZE, count + 2);
}

interface RankPass<T> {
  schema: z.ZodType<T>;
  /** Most outfits read from one reply; any beyond are ignored. */
  max: number;
  rules: OutfitRules;
  /** This many valid outfits make a reply good enough (no retry). */
  enough: number;
  call: () => Promise<ModelCall>;
  beforeCall: () => Promise<void>;
  onCall: (call: ModelCall) => Promise<void>;
  provider: string;
}

/**
 * One ranking pass with the single retry (step 4). Each outfit in a reply
 * is judged on its own: bad ones are dropped, never the good ones next to
 * them. A reply with enough valid outfits isn't retried. After two tries,
 * the attempt with the most valid outfits is used; none at all is ai_failed.
 */
async function rankPass<T extends CheckableOutfit>(pass: RankPass<T>): Promise<T[]> {
  let best: T[] = [];
  await callWithValidation(RankingReplyEnvelopeSchema, pass.call, {
    check: (reply) => {
      const { valid, problem } = checkReply(reply.outfits.slice(0, pass.max), pass.schema, pass.rules, pass.enough);
      if (valid.length > best.length) best = valid;
      return problem;
    },
    beforeCall: pass.beforeCall,
    onCall: pass.onCall,
    provider: pass.provider,
  });
  if (best.length === 0) throw aiFailed();
  return best;
}
