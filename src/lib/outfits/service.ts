/**
 * What the outfit API routes call. Joins the pipeline to storage, the
 * usage caps and feedback:
 *
 * - New request: check caps → load wardrobe → pipeline → save outfits
 *   (with any gaps the model described).
 * - Refine: record the swap or guidance → pipeline with the previous outfit
 *   and feedback → save outfits with parent_outfit_id.
 * - Status: save, like or reject; a rejection is recorded as feedback, and
 *   rejected outfits become "avoid" hints on later requests.
 *
 * Caps: every new request and refinement counts against the daily outfit
 * cap, but only once it reaches the model (an "incomplete wardrobe" answer
 * uses no AI and isn't counted). Each model call's cost is recorded for the
 * monthly cap, retries and failed calls included.
 */
import {
  GUIDANCE_MAX_LENGTH,
  PRESET_STYLES_BY_ID,
  type Outfit,
  type OutfitGenerationResponse,
  type OutfitRequest,
  type OutfitStatus,
  type RefineRequest,
  type StoredOutfitRequest,
  type StyleChoice,
  type UpdateOutfitStatusRequest,
} from "@/contracts";
import type { RankingProvider } from "@/lib/ai/types";
import { ApiException, notFound } from "@/lib/api/errors";
import { isAiPausedError } from "@/lib/usage/errors";
import type { UsageGuard, UsageReservation } from "@/lib/usage/guard";
import { MAX_REJECTED_OUTFITS_FOR_HINTS, REFINE_COUNT } from "./config";
import { runOutfitPipeline, type PipelineInput, type PipelineResult } from "./pipeline";
import type { OutfitRepository } from "./repository";
import type { ThumbnailSource } from "./thumbnails";

export interface OutfitServiceDeps {
  repository: OutfitRepository;
  /** A function so routes that don't rank (list, status) never need the Gemini key. */
  ranking: () => RankingProvider;
  thumbnails: ThumbnailSource;
  usage: UsageGuard;
  random?: () => number;
  now?: () => Date;
}

function styleLabel(style: StyleChoice): string {
  return style.kind === "preset" ? PRESET_STYLES_BY_ID[style.presetId].label.toLowerCase() : `"${style.text}"`;
}

/** The plain-English message for an incomplete wardrobe. */
export function incompleteMessage(
  result: Exclude<PipelineResult, { status: "ok" }>,
  style: StyleChoice,
  hasAnchor: boolean,
): string {
  if (result.reason === "empty_wardrobe") {
    return "Your wardrobe is empty. Add your first item and we'll suggest outfits around it.";
  }
  return hasAnchor
    ? `Nothing in your wardrobe goes with this item for ${styleLabel(style)} yet. Try another style, or add more items.`
    : `Nothing in your wardrobe suits ${styleLabel(style)} yet. Try another style, or add more items.`;
}

/** Guidance for a refinement: the earlier guidance plus the new, if both fit in one line. */
export function combineGuidance(previous: string | null, added: string): string {
  if (!previous) return added;
  const combined = `${previous}; ${added}`;
  return combined.length <= GUIDANCE_MAX_LENGTH ? combined : added;
}

export class OutfitService {
  private readonly random: () => number;
  private readonly now: () => Date;

  constructor(private readonly deps: OutfitServiceDeps) {
    this.random = deps.random ?? Math.random;
    this.now = deps.now ?? (() => new Date());
  }

  list(userId: string, status?: OutfitStatus): Promise<Outfit[]> {
    return this.deps.repository.listOutfits(userId, status);
  }

  async get(userId: string, outfitId: string): Promise<Outfit> {
    const outfit = await this.deps.repository.getOutfit(userId, outfitId);
    if (!outfit) throw notFound("That outfit");
    return outfit;
  }

  /** POST /api/outfits */
  async generate(userId: string, request: OutfitRequest): Promise<OutfitGenerationResponse> {
    const { repository, usage } = this.deps;
    await usage.assertCanStart(userId, "outfit_request");

    const items = await repository.listWardrobe(userId);
    if (request.anchorItemId && !items.some((i) => i.id === request.anchorItemId)) throw notFound("That item");

    const stored: StoredOutfitRequest = {
      style: request.style,
      guidance: request.guidance ?? null,
      anchorItemId: request.anchorItemId ?? null,
      includeShopItems: request.includeShopItems ?? false,
    };
    return this.run(userId, stored, null, {
      items,
      style: stored.style,
      guidance: stored.guidance,
      anchorItemId: stored.anchorItemId,
      includeShopItems: stored.includeShopItems,
      count: request.count,
    });
  }

  /** POST /api/outfits/[id]/refine */
  async refine(userId: string, outfitId: string, refine: RefineRequest): Promise<OutfitGenerationResponse> {
    const { repository, usage } = this.deps;
    const parent = await this.get(userId, outfitId);
    if (refine.kind === "swap" && !parent.itemIds.includes(refine.itemId)) {
      throw new ApiException("bad_request", "That item isn't in this outfit", {
        issues: [{ path: "itemId", message: "Not in this outfit" }],
      });
    }
    await usage.assertCanStart(userId, "outfit_request");
    await repository.addFeedback(userId, parent.id, refine.kind, refine.kind === "swap" ? refine.itemId : refine.text);

    const swappedOut = refine.kind === "swap" ? refine.itemId : null;
    const items = (await repository.listWardrobe(userId)).filter((i) => i.id !== swappedOut);
    const anchor = parent.request.anchorItemId;
    const anchorItemId = anchor && anchor !== swappedOut && items.some((i) => i.id === anchor) ? anchor : null;

    const stored: StoredOutfitRequest = {
      style: parent.request.style,
      guidance: refine.kind === "guidance" ? combineGuidance(parent.request.guidance, refine.text) : parent.request.guidance,
      anchorItemId,
      includeShopItems: parent.request.includeShopItems,
    };
    // Swapping out the wardrobe's only item leaves nothing to build from.
    if (items.length === 0) {
      return {
        status: "incomplete_wardrobe",
        reason: "nothing_fits",
        missingCategories: [],
        message: "There's nothing else in your wardrobe to swap in yet. Add more items to get other outfits.",
      };
    }
    const parentShape = { itemIds: parent.itemIds, gaps: parent.gaps.map((g) => g.category) };
    const previousGaps = parent.gaps.map(({ category, subcategory, colours, description }) => ({ category, subcategory, colours, description }));
    return this.run(userId, stored, parent.id, {
      items,
      style: stored.style,
      guidance: stored.guidance,
      anchorItemId,
      includeShopItems: stored.includeShopItems,
      count: REFINE_COUNT,
      keepItemIds: swappedOut ? parent.itemIds.filter((id) => id !== swappedOut) : undefined,
      // The outfit being refined doesn't come back. For guidance on an
      // outfit with gaps it may, when nothing else is possible (a sparse
      // wardrobe): the new gap descriptions are then the revision.
      ...(refine.kind === "guidance" && parent.gaps.length > 0
        ? { softExcludeOutfits: [parentShape] }
        : { excludeOutfits: [parentShape] }),
      refinement: { previousItemIds: parent.itemIds, ...(previousGaps.length > 0 ? { previousGaps } : {}), feedback: refine },
    });
  }

  /** PATCH /api/outfits/[id]. Rejecting also records feedback (once). */
  async updateStatus(userId: string, outfitId: string, body: UpdateOutfitStatusRequest): Promise<Outfit> {
    const { repository } = this.deps;
    const before = await this.get(userId, outfitId);
    const outfit = await repository.setStatus(userId, outfitId, body.status);
    if (!outfit) throw notFound("That outfit");
    if (body.status === "rejected" && before.status !== "rejected") {
      await repository.addFeedback(userId, outfitId, "reject", body.reason ?? null);
    }
    return outfit;
  }

  private async run(
    userId: string,
    stored: StoredOutfitRequest,
    parentOutfitId: string | null,
    input: Omit<PipelineInput, "rejectedOutfits">,
  ): Promise<OutfitGenerationResponse> {
    const { repository, usage, thumbnails } = this.deps;
    const rejectedOutfits = await repository.listRejectedOutfits(userId, MAX_REJECTED_OUTFITS_FOR_HINTS);
    // Each model call reserves its estimated cost before it's made, then
    // records the real cost: one meter per pass.
    const meters = {
      ranking_shortlist: usage.meterAiCalls(userId, "ranking_shortlist"),
      ranking_final: usage.meterAiCalls(userId, "ranking_final"),
    };

    const counted: { reservation: UsageReservation | null; modelCalled: boolean } = { reservation: null, modelCalled: false };
    let result;
    try {
      result = await runOutfitPipeline(
        { ...input, rejectedOutfits },
        {
          ranking: this.deps.ranking,
          thumbnails,
          random: this.random,
          now: this.now,
          // Counted atomically just before the first model call, so parallel
          // requests can't overshoot the daily cap.
          onRankingStart: async () => {
            counted.reservation = await usage.reserveAction(userId, "outfit_request");
          },
          beforeAiCall: (kind) => meters[kind].beforeCall(),
          recordAiCost: (kind, call) => {
            counted.modelCalled = true;
            return meters[kind].onCall(call);
          },
        },
      );
    } catch (error) {
      // AI paused before a model call (another request took the month to
      // the cap): the user gets no outfits, so give today's count back.
      // Only if no model call was made: once pass 1 has run (and may be
      // billed), a pause before pass 2 keeps the request counted.
      if (counted.reservation && !counted.modelCalled && isAiPausedError(error)) await counted.reservation.cancel().catch(() => {});
      throw error;
    }

    if (result.status !== "ok") {
      return {
        status: "incomplete_wardrobe",
        reason: result.reason,
        missingCategories: result.missingCategories,
        message: incompleteMessage(result, stored.style, stored.anchorItemId !== null),
      };
    }
    const outfits = await repository.insertOutfits(
      userId,
      result.outfits.map((o) => ({ request: stored, name: o.name, reason: o.reason, itemIds: o.itemIds, gaps: o.gaps, parentOutfitId })),
    );
    return { status: "ok", outfits, missingCategories: result.missingCategories };
  }
}
