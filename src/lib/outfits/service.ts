/**
 * What the outfit API routes call. Joins the pipeline to storage, the
 * usage caps and feedback:
 *
 * - New request: check caps → load wardrobe → pipeline → save outfits.
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
  type Category,
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
import type { UsageGuard } from "@/lib/usage/guard";
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

const CATEGORY_NAMES: Record<Category, string> = {
  top: "a top",
  bottom: "a bottom",
  dress_jumpsuit: "a dress or jumpsuit",
  outerwear: "a jacket or coat",
  shoes: "shoes",
};

function joinWithAnd(parts: string[]): string {
  return parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
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
  if (result.reason === "missing_category") {
    const add = joinWithAnd(result.missingCategories.map((c) => CATEGORY_NAMES[c]));
    return hasAnchor
      ? `To build an outfit around this item, add ${add} to your wardrobe.`
      : `Add ${add} to your wardrobe to get outfits.`;
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
    };
    return this.run(userId, stored, null, {
      items,
      style: stored.style,
      guidance: stored.guidance,
      anchorItemId: stored.anchorItemId,
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
    };
    return this.run(userId, stored, parent.id, {
      items,
      style: stored.style,
      guidance: stored.guidance,
      anchorItemId,
      count: REFINE_COUNT,
      keepItemIds: swappedOut ? parent.itemIds.filter((id) => id !== swappedOut) : undefined,
      excludeOutfits: [parent.itemIds],
      refinement: { previousItemIds: parent.itemIds, feedback: refine },
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
    const rejectedOutfits = await repository.listRejectedItemIds(userId, MAX_REJECTED_OUTFITS_FOR_HINTS);

    const result = await runOutfitPipeline(
      { ...input, rejectedOutfits },
      {
        ranking: this.deps.ranking(),
        thumbnails,
        random: this.random,
        now: this.now,
        onRankingStart: () => usage.recordAction(userId, "outfit_request"),
        recordAiCost: (kind, call) => usage.recordAiCost(userId, kind, call.costPence, call.provider),
      },
    );

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
      result.outfits.map((o) => ({ request: stored, name: o.name, reason: o.reason, itemIds: o.itemIds, parentOutfitId })),
    );
    return { status: "ok", outfits };
  }
}
