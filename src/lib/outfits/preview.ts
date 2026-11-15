/**
 * Round 2: POST /api/outfits/[id]/preview, the real version (spec:
 * "Generated outfit preview"; CONTRACTS.md section 12).
 *
 *  1. Load the outfit (not_found) and the user's preset (bad_request with
 *     path modelPresetId when none).
 *  2. Work out the look: previewCacheKey({ presetId, itemIds, gaps }).
 *  3. ?refresh=true: assertCanStart("outfit_preview") first, so a refresh
 *     that can't run changes nothing. Skipped for a poll: the outfit
 *     already has a fresh pending_preview_id (the refresh is being made).
 *  4. claim_outfit_preview. existing / reused / wait / unavailable: remove
 *     the released image, return the outfit.
 *  5. generate: count one outfit_preview (a cap or pause finishes the row
 *     as skipped), build the model input, then at most two image calls,
 *     each metered as image_generation. Each reply is sniffed and fully
 *     decoded (inspectGeneratedImage), checked
 *     (checkGeneratedPreviewImage), re-encoded as exactly-2:3 WebP and
 *     stored in the previews bucket.
 *  6. finish_outfit_preview: ready, or failed with the last attempt's
 *     reason (ai_failed, blocked, invalid_image; internal for our own
 *     errors) and 502 ai_failed. Remove every released image; when finish
 *     says the row has gone, remove the image just stored.
 *
 * Time: everything is bounded by PREVIEW_ROUTE_BUDGET_MS, inside the
 * route's maxDuration (90 s), which is itself shorter than the 150 s after
 * which another request may take over a pending preview.
 */
import {
  PREVIEW_ASPECT_RATIO,
  PREVIEW_NEEDS_PRESET_ISSUE_PATH,
  PREVIEW_PENDING_STALE_SECONDS,
  STORAGE_BUCKETS,
  MODEL_PRESETS_BY_ID,
  checkGeneratedPreviewImage,
  previewCacheKey,
  type GeneratedImageFacts,
  type ItemTags,
  type Outfit,
  type OutfitGap,
  type PreviewFailureReason,
} from "@/contracts";
import type { ImageGenerationCall, ImageGenerationInput, ImageGenerationProvider, ImageInput, PreviewGapInput, PreviewItemInput } from "@/lib/ai/types";
import { ProviderQuotaError } from "@/lib/ai/errors";
import { ApiException, notFound } from "@/lib/api/errors";
import { describeError } from "@/lib/api/http";
import type { ImageStorage } from "@/lib/ingestion/storage";
import { CapReachedError } from "@/lib/usage/errors";
import type { UsageGuard, UsageReservation } from "@/lib/usage/guard";
import type { PreviewRepository, FinishPreviewArgs } from "./preview-repository";
import type { OutfitRepository } from "./repository";
import { mapWithLimit, type ImageStore } from "./thumbnails";
import type { WardrobeEntry } from "./types";

/** The whole route's work, well inside maxDuration (90 s). */
export const PREVIEW_ROUTE_BUDGET_MS = 80_000;
/** Most time spent fetching picked shop products' pictures (in parallel). */
export const PREVIEW_PRODUCT_IMAGE_BUDGET_MS = 8_000;
/** Most time loading one item's picture (download and shrink) may take; slower ones are described in words. */
export const PREVIEW_ITEM_IMAGE_BUDGET_MS = 8_000;
/** Most time one image call may take. */
export const PREVIEW_ATTEMPT_TIMEOUT_MS = 35_000;
/** Kept back after the image calls for storing the image and finishing. */
export const PREVIEW_STORE_RESERVE_MS = 5_000;
/** A second attempt is only started with at least this long left. */
export const PREVIEW_MIN_ATTEMPT_MS = 15_000;
/** Longest side of each input picture sent to the image model. */
export const PREVIEW_INPUT_IMAGE_PX = 768;
const ITEM_IMAGE_CONCURRENCY = 4;

export function needsPresetError(): ApiException {
  return new ApiException("bad_request", "Pick a model for your outfit pictures first.", {
    issues: [{ path: PREVIEW_NEEDS_PRESET_ISSUE_PATH, message: "No model preset picked yet" }],
  });
}

/** The preset figure's picture (shipped in public/presets). */
export interface PresetImageSource {
  load(presetId: string): Promise<ImageInput>;
}

/** Gets a picked product's picture for the image model, or null (the gap is then described in words). */
export interface ProductImageFetcher {
  fetch(product: NonNullable<OutfitGap["shopProduct"]>, timeoutMs: number): Promise<ImageInput | null>;
}

export interface PreviewServiceDeps {
  repository: PreviewRepository;
  /** Reads the outfit back for the response, previews included. */
  outfits: Pick<OutfitRepository, "getOutfit">;
  usage: UsageGuard;
  provider: () => ImageGenerationProvider;
  /** Item pictures (cut-outs and originals). */
  itemImages: ImageStore;
  /** The previews bucket (admin client: only the server writes there). */
  previewStorage: Pick<ImageStorage, "upload" | "remove">;
  presets: PresetImageSource;
  productImages: ProductImageFetcher;
  /** A small model-ready JPEG (images.prepareForModel). */
  prepareForModel: (image: ImageInput, maxPx: number) => Promise<ImageInput>;
  /** The full decode for the checks (inspectGeneratedImage). */
  inspect: (data: Uint8Array) => Promise<GeneratedImageFacts>;
  /** Exactly-2:3 WebP for storage (encodePreviewForStorage). */
  encodeForStorage: (data: Uint8Array) => Promise<ImageInput>;
  now?: () => number;
  newImageKey?: (userId: string) => string;
}

/** "quota": the provider refused the call for quota (HTTP 429); nothing was billed and it isn't retried. */
type AttemptOutcome = { ok: true; image: Uint8Array } | { ok: false; reason: PreviewFailureReason | "quota" };

/** Words for an owned piece: its tag description, plus its tags in words when there's no picture. */
export function describeItem(tags: ItemTags, hasPicture: boolean): string {
  if (hasPicture) return tags.description;
  const pattern = tags.pattern === "plain" ? "plain" : `${tags.pattern} pattern`;
  const parts = [`${tags.colours.join(" and ")} ${pattern} ${tags.subcategory.replace(/_/g, " ")}`];
  if (tags.fabric) parts.push(`in ${tags.fabric}`);
  return `${parts.join(" ")}. ${tags.description}`;
}

/** Rejects after `ms` (calling `onTimeout`, e.g. to abort the work), unless `promise` settles first. */
function timeout<T>(promise: Promise<T>, ms: number, onTimeout?: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        onTimeout?.();
        reject(new Error(`Timed out after ${ms} ms`));
      }, Math.max(0, ms));
    }),
  ]).finally(() => clearTimeout(timer));
}

export class PreviewService {
  private readonly now: () => number;
  private readonly newImageKey: (userId: string) => string;

  constructor(private readonly deps: PreviewServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.newImageKey = deps.newImageKey ?? ((userId) => `${userId}/${crypto.randomUUID()}.webp`);
  }

  async preview(userId: string, outfitId: string, refresh: boolean): Promise<Outfit> {
    const started = this.now();
    const { repository, usage } = this.deps;
    const source = await repository.getOutfitSource(userId, outfitId);
    if (!source) throw notFound("That outfit");
    const presetId = await repository.getModelPresetId(userId);
    if (!presetId || !MODEL_PRESETS_BY_ID.has(presetId)) throw needsPresetError();
    const { row } = source;
    const cacheKey = await previewCacheKey({ presetId, itemIds: row.item_ids, gaps: row.gaps });

    if (refresh && !(await this.isRefreshPoll(userId, row.pending_preview_id))) {
      await usage.assertCanStart(userId, "outfit_preview");
    }

    const claim = await repository.claim({ userId, outfitId, cacheKey, presetId, refresh });
    if (!claim.ok) throw notFound("That outfit");
    await this.removeImages(claim.released_image_key ? [claim.released_image_key] : []);
    if (claim.action === "generate") {
      await this.generate(userId, claim.preview_id, presetId, source.items, row.gaps, started);
    }
    return this.readBack(userId, outfitId);
  }

  /** A refresh already in progress and fresh: this POST is the UI asking again. */
  private async isRefreshPoll(userId: string, pendingPreviewId: string | null): Promise<boolean> {
    if (!pendingPreviewId) return false;
    const pending = await this.deps.repository.getPreview(userId, pendingPreviewId);
    if (!pending || pending.status !== "pending") return false;
    return this.now() - Date.parse(pending.attempted_at) < PREVIEW_PENDING_STALE_SECONDS * 1000;
  }

  private async readBack(userId: string, outfitId: string): Promise<Outfit> {
    const outfit = await this.deps.outfits.getOutfit(userId, outfitId);
    if (!outfit) throw notFound("That outfit");
    return outfit;
  }

  private async generate(
    userId: string,
    previewId: string,
    presetId: string,
    items: readonly WardrobeEntry[],
    gaps: readonly OutfitGap[],
    started: number,
  ): Promise<void> {
    const { usage } = this.deps;
    const remaining = () => PREVIEW_ROUTE_BUDGET_MS - (this.now() - started);

    let reservation: UsageReservation;
    try {
      reservation = await usage.reserveAction(userId, "outfit_preview");
    } catch (error) {
      if (error instanceof CapReachedError) await this.finishSkipped(userId, previewId, error);
      else await this.finishFailed(userId, previewId, "internal");
      throw error;
    }

    let calls = 0;
    try {
      const input = await this.buildInput(presetId, items, gaps);
      const provider = this.deps.provider();
      const meter = usage.meterAiCalls(userId, "image_generation", provider.name);
      let lastReason: PreviewFailureReason = "ai_failed";

      for (let attempt = 0; attempt < 2; attempt++) {
        const left = remaining() - PREVIEW_STORE_RESERVE_MS;
        // Every attempt, the first included: a call that can't finish in time isn't started (nor paid for).
        if (left < PREVIEW_MIN_ATTEMPT_MS) {
          console.warn("Preview: not enough time left for an image call", { attempt: attempt + 1, leftMs: left });
          break;
        }
        try {
          await meter.beforeCall();
        } catch (error) {
          if (error instanceof CapReachedError) {
            // Paused before any model call: give the count back. After a paid call it stays.
            if (calls === 0) await reservation.cancel().catch(() => {});
            await this.finishSkipped(userId, previewId, error);
          }
          throw error;
        }
        calls++;
        const outcome = await this.attempt(provider, input, meter, Math.min(PREVIEW_ATTEMPT_TIMEOUT_MS, left));
        if (outcome.ok) {
          await this.store(userId, previewId, outcome.image);
          return;
        }
        if (outcome.reason === "quota") {
          // No retry: the quota won't be back within this request. Skipped
          // (ai_paused, the nearest skipped reason), so a later POST tries
          // again; the count is given back unless an earlier call may have cost.
          if (calls === 1) await reservation.cancel().catch(() => {});
          await this.finishQuietly({ userId, previewId, status: "skipped", failureReason: "ai_paused" });
          throw new ApiException("ai_paused", "Outfit pictures aren't available right now. Your outfits show as collages instead.");
        }
        lastReason = outcome.reason;
      }

      // Out of time before any model call: the count is given back.
      if (calls === 0) await reservation.cancel().catch(() => {});
      await this.finishFailed(userId, previewId, lastReason);
      throw new ApiException("ai_failed", "We couldn't make a picture of this outfit. It shows as a collage instead.");
    } catch (error) {
      if (error instanceof ApiException || error instanceof CapReachedError) throw error;
      console.error("Preview generation failed", describeError(error));
      if (calls === 0) await reservation.cancel().catch(() => {});
      await this.finishFailed(userId, previewId, "internal");
      throw error;
    }
  }

  /** One image call, metered, then the checks. Never throws for what the model does. */
  private async attempt(
    provider: ImageGenerationProvider,
    input: ImageGenerationInput,
    meter: ReturnType<UsageGuard["meterAiCalls"]>,
    timeoutMs: number,
  ): Promise<AttemptOutcome> {
    let call: ImageGenerationCall;
    // Cancels the request itself at the time limit, so it can't overlap the retry.
    const controller = new AbortController();
    try {
      call = await timeout(provider.generatePreview(input, { signal: controller.signal }), timeoutMs, () => controller.abort());
    } catch (error) {
      if (error instanceof ProviderQuotaError) {
        // Refused before any work (HTTP 429): nothing was billed, so 0p is booked.
        await meter.onCall({ costPence: 0, provider: provider.name });
        console.warn("Preview: image model quota used up", describeError(error));
        return { ok: false, reason: "quota" };
      }
      // A timed-out or failed call may still be billed: the estimate stands.
      await meter.onCall({ provider: provider.name });
      console.warn("Preview: image model call failed", describeError(error));
      return { ok: false, reason: "ai_failed" };
    }
    await meter.onCall({ costPence: call.costPence, provider: call.provider });
    if (!call.image) {
      if (call.blockReason) console.warn("Preview: image model refused", { blockReason: call.blockReason, model: call.model });
      return { ok: false, reason: call.blockReason ? "blocked" : "ai_failed" };
    }
    const facts = await this.deps.inspect(call.image.data);
    const check = checkGeneratedPreviewImage(facts);
    if (!check.ok) {
      console.warn("Preview: generated image failed the checks", { problem: check.problem, model: call.model });
      return { ok: false, reason: "invalid_image" };
    }
    return { ok: true, image: call.image.data };
  }

  /** Re-encode, store, finish as ready; tidy up what finish released or refused. */
  private async store(userId: string, previewId: string, data: Uint8Array): Promise<void> {
    const encoded = await this.deps.encodeForStorage(data);
    const key = this.newImageKey(userId);
    await this.deps.previewStorage.upload(STORAGE_BUCKETS.previews, key, encoded);
    let result;
    try {
      result = await this.deps.repository.finish({ userId, previewId, status: "ready", imageKey: key });
    } catch (error) {
      await this.removeImages([key]);
      throw error;
    }
    // ok false: the row went (an item it shows was deleted or got a new photo) or is no longer pending.
    await this.removeImages(result.ok ? result.released_image_keys : [key, ...result.released_image_keys]);
  }

  private async buildInput(presetId: string, items: readonly WardrobeEntry[], gaps: readonly OutfitGap[]): Promise<ImageGenerationInput> {
    const preset = MODEL_PRESETS_BY_ID.get(presetId)!;
    const [presetImage, itemInputs, gapInputs] = await Promise.all([
      this.deps.presets.load(presetId),
      mapWithLimit(items, ITEM_IMAGE_CONCURRENCY, (item) => this.itemInput(item)),
      Promise.all(gaps.map((gap) => this.gapInput(gap))),
    ]);
    return { preset: { id: preset.id, label: preset.label, image: presetImage }, items: itemInputs, gaps: gapInputs, aspectRatio: PREVIEW_ASPECT_RATIO };
  }

  private async itemInput(item: WardrobeEntry): Promise<PreviewItemInput> {
    let image: ImageInput | null = null;
    if (item.image) {
      try {
        const ref = item.image;
        const load = async () => this.deps.prepareForModel(await this.deps.itemImages.download(ref), PREVIEW_INPUT_IMAGE_PX);
        image = await timeout(load(), PREVIEW_ITEM_IMAGE_BUDGET_MS);
      } catch (error) {
        // Described in words instead, like an item still waiting for a photo.
        console.warn("Preview: item picture not loaded; described in words", describeError(error));
      }
    }
    return { category: item.tags.category, image, description: describeItem(item.tags, image !== null) };
  }

  private async gapInput(gap: OutfitGap): Promise<PreviewGapInput> {
    let productImage: ImageInput | null = null;
    if (gap.shopProduct) {
      try {
        // The fetch has its own limit; this one also bounds checking and shrinking the picture.
        productImage = await timeout(this.deps.productImages.fetch(gap.shopProduct, PREVIEW_PRODUCT_IMAGE_BUDGET_MS), PREVIEW_PRODUCT_IMAGE_BUDGET_MS + 2_000);
      } catch (error) {
        console.warn("Preview: shop picture not loaded; described in words", describeError(error));
      }
    }
    return { category: gap.category, subcategory: gap.subcategory, colours: gap.colours, description: gap.description, productImage };
  }

  private async finishSkipped(userId: string, previewId: string, error: CapReachedError): Promise<void> {
    await this.finishQuietly({
      userId,
      previewId,
      status: "skipped",
      failureReason: error.cap === "outfit_previews_per_day" ? "daily_cap_reached" : "ai_paused",
    });
  }

  private async finishFailed(userId: string, previewId: string, reason: PreviewFailureReason): Promise<void> {
    await this.finishQuietly({ userId, previewId, status: "failed", failureReason: reason });
  }

  /** Finish without an image; a failure here leaves the row pending, taken over once stale. */
  private async finishQuietly(args: FinishPreviewArgs): Promise<void> {
    try {
      const result = await this.deps.repository.finish(args);
      await this.removeImages(result.released_image_keys);
    } catch (error) {
      console.error("Couldn't finish the outfit preview", describeError(error));
    }
  }

  /** Best effort: the daily orphaned-image cleanup catches anything left behind. */
  private async removeImages(keys: readonly string[]): Promise<void> {
    if (keys.length === 0) return;
    try {
      await this.deps.previewStorage.remove(STORAGE_BUCKETS.previews, keys);
    } catch (error) {
      console.error("Couldn't remove released preview images", describeError(error));
    }
  }
}
