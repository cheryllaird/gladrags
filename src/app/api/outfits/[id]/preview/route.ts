// Generate (or reuse) an outfit's "wearing it" preview. Round 2 route
// contract from foundations; outfit-engine builds the real one (P2).
// See docs/CONTRACTS.md section 12 and PreviewResponseSchema.
//
// STUB: mock mode only (src/lib/mocks/previews.ts); not_implemented
// otherwise until outfit-engine replaces it. The real route:
//  1. requireUser; load the outfit (not_found if it isn't the user's).
//  2. Read user_settings.model_preset_id; none → needsPresetError() (bad_request).
//  3. previewCacheKey({ presetId, itemIds, gaps }) with the outfit's current gaps.
//  4. With ?refresh=true, assertCanStart("outfit_preview") first, so a capped
//     refresh doesn't unlink the outdated image for nothing.
//  5. claim_outfit_preview (admin client). existing / reused / wait: return
//     the outfit. generate: reserveAction("outfit_preview") (skipped on a cap
//     or pause), build ImageGenerationInput (item images; gaps in words, or a
//     picked product's picture via safeFetch), meter image_generation, check
//     with checkGeneratedPreviewImage, retry once, store as WebP in the
//     previews bucket, set the row ready (or failed), remove any
//     released_image_key from storage, and return the outfit.
import { IdParamsSchema, PreviewRequestQuerySchema, PreviewResponseSchema } from "@/contracts";
import { jsonResponse, parseRouteParams, parseSearchParams, withApiHandler } from "@/lib/api/http";
import { assertMockModeForStub } from "@/lib/api/stub";
import { requireUser } from "@/lib/auth/session";
import { mockPreview } from "@/lib/mocks/previews";
import { getUsageGuard } from "@/lib/usage";

interface Context {
  params: Promise<{ id: string }>;
}

/** One image generation (up to two attempts) plus storing it. Shorter than PREVIEW_PENDING_STALE_SECONDS. */
export const maxDuration = 90;

export const POST = withApiHandler(async (request, { params }: Context) => {
  const user = await requireUser();
  const { id } = await parseRouteParams(params, IdParamsSchema);
  const { refresh } = parseSearchParams(request, PreviewRequestQuerySchema);
  assertMockModeForStub("Outfit previews");
  return jsonResponse(PreviewResponseSchema, { outfit: await mockPreview(user.id, id, refresh, getUsageGuard()) });
});
