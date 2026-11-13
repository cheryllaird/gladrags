/**
 * Outfit previews in mock mode (round 2), until outfit-engine builds the
 * real route (PROGRESS.md P2). Works like the real one will, without a
 * model: the look's cache key decides reuse, a generation "takes" a short
 * delay and comes back with a mock picture, and markers in the outfit's
 * guidance or custom style give the failure, cap and pause states.
 */
import "server-only";
import { ApiException, notFound } from "@/lib/api/errors";
import { CapReachedError } from "@/lib/usage/errors";
import { MONTHLY_SPEND_SHARES, DAILY_CAPS, USAGE_TIME_ZONE } from "@/lib/usage/config";
import { startOfNextDay, startOfNextMonth } from "@/lib/usage/time";
import type { UsageGuard } from "@/lib/usage/guard";
import { PREVIEW_NEEDS_PRESET_ISSUE_PATH, previewCacheKey, type Outfit } from "@/contracts";
import { MOCK_MARKERS, hasMarker } from "./markers";
import * as mock from "./store";

/** Mock pictures: one for a complete outfit, one showing suggested (gap) pieces. */
export const MOCK_PREVIEW_IMAGE_URL = "/mock/previews/preview.svg";
export const MOCK_PREVIEW_WITH_SUGGESTIONS_IMAGE_URL = "/mock/previews/preview-suggested.svg";

/** How long a mock generation takes. GLADRAGS_MOCK_PREVIEW_DELAY_MS overrides it (tests use 0). */
function delayMs(): number {
  const fromEnv = Number(process.env.GLADRAGS_MOCK_PREVIEW_DELAY_MS);
  return Number.isFinite(fromEnv) && fromEnv >= 0 ? fromEnv : 1200;
}

export function needsPresetError(): ApiException {
  return new ApiException("bad_request", "Pick a model for your outfit pictures first.", {
    issues: [{ path: PREVIEW_NEEDS_PRESET_ISSUE_PATH, message: "No model preset picked yet" }],
  });
}

/** POST /api/outfits/[id]/preview in mock mode. */
export async function mockPreview(userId: string, outfitId: string, refresh: boolean, usage: UsageGuard): Promise<Outfit> {
  const outfit = mock.getOutfit(outfitId);
  if (!outfit) throw notFound("That outfit");
  const { modelPresetId } = mock.getSettings();
  if (!modelPresetId) throw needsPresetError();

  const cacheKey = await previewCacheKey({ presetId: modelPresetId, itemIds: outfit.itemIds, gaps: outfit.gaps });
  const action = mock.claimPreview(outfitId, cacheKey, modelPresetId, refresh);
  if (action !== "generate") return mock.getOutfit(outfitId)!;

  const texts = [outfit.request.guidance, outfit.request.style.kind === "custom" ? outfit.request.style.text : null];
  const now = new Date();
  if (hasMarker(texts, MOCK_MARKERS.previewCap)) {
    mock.finishPreview(cacheKey, { status: "skipped", failureReason: "daily_cap_reached" });
    throw new CapReachedError("outfit_previews_per_day", DAILY_CAPS.outfit_preview, startOfNextDay(now, USAGE_TIME_ZONE));
  }
  if (hasMarker(texts, MOCK_MARKERS.previewPaused)) {
    mock.finishPreview(cacheKey, { status: "skipped", failureReason: "ai_paused" });
    throw new CapReachedError("monthly_image_spend", MONTHLY_SPEND_SHARES.images.capPence, startOfNextMonth(now, USAGE_TIME_ZONE));
  }
  try {
    // Counts against the (in-memory) daily preview cap like the real route.
    await usage.reserveAction(userId, "outfit_preview");
  } catch (error) {
    if (error instanceof CapReachedError) {
      mock.finishPreview(cacheKey, { status: "skipped", failureReason: error.cap === "outfit_previews_per_day" ? "daily_cap_reached" : "ai_paused" });
    }
    throw error;
  }

  await new Promise((resolve) => setTimeout(resolve, delayMs()));
  if (hasMarker(texts, MOCK_MARKERS.previewFails)) {
    mock.finishPreview(cacheKey, { status: "failed", failureReason: "ai_failed" });
    throw new ApiException("ai_failed", "We couldn't make a picture of this outfit. It shows as a collage instead.");
  }
  mock.finishPreview(cacheKey, {
    status: "ready",
    imageUrl: outfit.gaps.length > 0 ? MOCK_PREVIEW_WITH_SUGGESTIONS_IMAGE_URL : MOCK_PREVIEW_IMAGE_URL,
  });
  return mock.getOutfit(outfitId)!;
}
