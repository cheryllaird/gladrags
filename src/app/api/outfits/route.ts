// Real implementation (outfit-engine): list outfits, and ask for new ones.
// The pipeline is in src/lib/outfits/. In mock mode it runs on the
// in-memory wardrobe with a mock ranking model. See docs/CONTRACTS.md.
import {
  OutfitGenerationResponseSchema,
  OutfitListQuerySchema,
  OutfitListResponseSchema,
  OutfitRequestSchema,
} from "@/contracts";
import { jsonResponse, parseJsonBody, parseSearchParams, withApiHandler } from "@/lib/api/http";
import { requireUser } from "@/lib/auth/session";
import { isMockMode } from "@/lib/env";
import { MOCK_MARKERS, hasMarker, throwIfCapMarker } from "@/lib/mocks/markers";
import * as mock from "@/lib/mocks/store";
import { getOutfitService } from "@/lib/outfits";

/** Two model calls plus thumbnails can take a while; allow up to a minute on Vercel. */
export const maxDuration = 60;

/** List outfits, e.g. ?status=saved for the saved outfits screen. Newest first. */
export const GET = withApiHandler(async (request) => {
  const user = await requireUser();
  const { status } = parseSearchParams(request, OutfitListQuerySchema);
  const service = await getOutfitService();
  return jsonResponse(OutfitListResponseSchema, { outfits: await service.list(user.id, status) });
});

/** Ask for outfits for a style or occasion, optionally around one item. */
export const POST = withApiHandler(async (request) => {
  const user = await requireUser();
  const body = await parseJsonBody(request, OutfitRequestSchema);
  if (isMockMode()) {
    const texts = [body.guidance, body.style.kind === "custom" ? body.style.text : null];
    throwIfCapMarker(texts, "outfit_request");
    // Until the engine makes gaps (milestone 5), mock mode answers
    // "Include items from my shops" and the mock-gaps marker with canned
    // outfits that each have a shoes gap (not around an anchor item).
    if (!body.anchorItemId && (body.includeShopItems || hasMarker(texts, MOCK_MARKERS.gaps))) {
      const outfits = mock.mockGapOutfits({
        style: body.style,
        guidance: body.guidance ?? null,
        anchorItemId: null,
        includeShopItems: body.includeShopItems ?? false,
      });
      if (outfits.length > 0) {
        // The marker plays a wardrobe without shoes (a required-slot gap);
        // includeShopItems plays a shop-item gap on a wardrobe that has
        // shoes, so nothing is missing.
        const missingCategories = hasMarker(texts, MOCK_MARKERS.gaps) ? (["shoes"] as const) : [];
        return jsonResponse(OutfitGenerationResponseSchema, { status: "ok", outfits, missingCategories: [...missingCategories] });
      }
    }
  }
  const service = await getOutfitService();
  return jsonResponse(OutfitGenerationResponseSchema, await service.generate(user.id, body));
});
