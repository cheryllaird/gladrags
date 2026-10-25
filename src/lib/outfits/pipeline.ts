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
import {
  RankingFinalOutputSchema,
  RankingShortlistOutputSchema,
  missingCategoriesForOutfits,
  type AiCostKind,
  type Category,
  type StyleChoice,
} from "@/contracts";
import type { ModelCall, RankingContext, RankingProvider } from "@/lib/ai/types";
import { callWithValidation } from "@/lib/ai/validate";
import { ApiException } from "@/lib/api/errors";
import { avoidPairsFromRejected, generateCandidates } from "./candidates";
import { MAX_AVOID_PAIRS, MAX_CANDIDATES_SENT, SHORTLIST_SIZE } from "./config";
import { FILTER_LEVELS, filterItems } from "./filter";
import { seasonAt } from "./season";
import type { ThumbnailSource } from "./thumbnails";
import type { RankedOutfit, WardrobeEntry } from "./types";
import { describeProblems, validateOutfits, type OutfitRules } from "./validate";

export interface PipelineDeps {
  /** Makes the ranking provider; called only once the model is needed. */
  ranking: () => RankingProvider;
  thumbnails: ThumbnailSource;
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
  /** How many outfits to return. */
  count: number;
  /** Swap refinement: the outfit's other items, kept if possible. */
  keepItemIds?: readonly string[];
  /** Item IDs of outfits the user rejected, newest first: "avoid" hints. */
  rejectedOutfits: readonly (readonly string[])[];
  /** Exact combinations not to suggest again (the outfit being refined). */
  excludeOutfits?: readonly (readonly string[])[];
  refinement?: RankingContext["refinement"];
}

export type PipelineResult =
  | { status: "ok"; outfits: RankedOutfit[] }
  | { status: "incomplete_wardrobe"; reason: "missing_category"; missingCategories: Category[] }
  | { status: "incomplete_wardrobe"; reason: "nothing_fits"; missingCategories: [] };

interface Choice {
  requiredIds: string[];
  items: WardrobeEntry[];
  candidates: string[][];
  avoidPairs: [string, string][];
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

function aiFailed(): ApiException {
  return new ApiException("ai_failed", "We couldn't put outfits together just now. Please try again.");
}

export async function runOutfitPipeline(input: PipelineInput, deps: PipelineDeps): Promise<PipelineResult> {
  const byId = new Map(input.items.map((item) => [item.id, item]));
  const anchor = input.anchorItemId ? byId.get(input.anchorItemId) : undefined;
  if (input.anchorItemId && !anchor) throw new Error("The anchor item must be in the wardrobe");

  // Can the wardrobe make any outfit at all (around the anchor, if any)?
  const present = new Set(input.items.map((i) => i.tags.category));
  const missing = missingCategoriesForOutfits(present, anchor?.tags.category);
  if (missing.length > 0) return { status: "incomplete_wardrobe", reason: "missing_category", missingCategories: missing };

  // Steps 1 and 2: filter, then generate candidates. For each set of
  // required items, use the strictest filter level that gives enough
  // candidates for `count` outfits, or else the level that gives the most.
  const season = seasonAt(deps.now());
  const excludeOutfits = [...input.rejectedOutfits, ...(input.excludeOutfits ?? [])];
  let chosen: Choice | null = null;
  for (const requiredIds of requiredSetsFor(input)) {
    for (const level of FILTER_LEVELS) {
      const filtered = filterItems(input.items, { style: input.style, season, ...level, keepIds: new Set(requiredIds) });
      const avoidPairs = avoidPairsFromRejected(input.rejectedOutfits, new Set(filtered.map((i) => i.id)), MAX_AVOID_PAIRS);
      const { candidates } = generateCandidates(filtered, {
        requiredIds,
        excludeOutfits,
        avoidPairs,
        limit: MAX_CANDIDATES_SENT,
        random: deps.random,
      });
      if (candidates.length > (chosen?.candidates.length ?? 0)) {
        chosen = { requiredIds, items: filtered, candidates, avoidPairs };
      }
      if (candidates.length >= input.count) break;
    }
    if (chosen) break;
  }
  if (!chosen) return { status: "incomplete_wardrobe", reason: "nothing_fits", missingCategories: [] };

  const { requiredIds, items, candidates, avoidPairs } = chosen;
  const context: RankingContext = {
    request: {
      style: input.style,
      anchorItemId: input.anchorItemId ?? undefined,
      guidance: input.guidance ?? undefined,
    },
    avoidPairs,
    refinement: input.refinement,
  };
  const rulesFor = (known: readonly WardrobeEntry[]): OutfitRules => ({
    known: new Map<string, Category>(known.map((i) => [i.id, i.tags.category])),
    anchorItemId: input.anchorItemId,
    requiredIds,
    excludeOutfits,
  });

  // Created only now, so an incomplete wardrobe never needs the model, and
  // a missing API key (ConfigError) surfaces before the request is counted
  // rather than looking like a failed model call.
  const ranking = deps.ranking();
  await deps.onRankingStart();

  // Step 3a: shortlist on tags. With only a few candidates there's nothing
  // to shortlist, so pass 1 is skipped and they all go to pass 2.
  let shortlist: string[][];
  if (candidates.length <= SHORTLIST_SIZE) {
    shortlist = candidates;
  } else {
    const rules = rulesFor(items);
    let lastValid: { itemIds: string[] }[] = [];
    const result = await callWithValidation(
      RankingShortlistOutputSchema,
      () =>
        ranking.shortlist({
          ...context,
          items: items.map(({ id, tags }) => ({ id, tags })),
          candidates,
          shortlistSize: SHORTLIST_SIZE,
        }),
      {
        check: (out) => {
          const check = validateOutfits(out.outfits, rules);
          lastValid = check.valid;
          return describeProblems(check);
        },
        onCall: (call) => deps.recordAiCost("ranking_shortlist", call),
        provider: ranking.name,
      },
    );
    // Step 4 for pass 1: with one retry used up, drop the bad outfits and keep the rest.
    const valid = result.ok ? result.data.outfits : lastValid;
    if (valid.length === 0) throw aiFailed();
    shortlist = valid.map((o) => o.itemIds);
  }

  // Step 3b: pick the best N, looking at thumbnails of the shortlisted items.
  const shortlistIds = [...new Set(shortlist.flat())];
  const shortlistItems = shortlistIds.map((id) => byId.get(id)!);
  const thumbnails = await deps.thumbnails.getThumbnails(shortlistItems);
  const rules = rulesFor(shortlistItems);
  let lastValid: RankedOutfit[] = [];
  const result = await callWithValidation(
    RankingFinalOutputSchema,
    () =>
      ranking.pickFinal({
        ...context,
        shortlist: shortlist.map((itemIds) => ({
          itemIds,
          thumbnails: itemIds.flatMap((itemId) => {
            const image = thumbnails.get(itemId);
            return image ? [{ itemId, image }] : [];
          }),
        })),
        count: input.count,
      }),
    {
      check: (out) => {
        const check = validateOutfits(out.outfits, rules);
        lastValid = check.valid;
        return describeProblems(check);
      },
      onCall: (call) => deps.recordAiCost("ranking_final", call),
      provider: ranking.name,
    },
  );
  // Step 4 for pass 2: same rule. Never more than asked for.
  const picked = result.ok ? result.data.outfits : lastValid;
  if (picked.length === 0) throw aiFailed();
  return { status: "ok", outfits: picked.slice(0, input.count) };
}
