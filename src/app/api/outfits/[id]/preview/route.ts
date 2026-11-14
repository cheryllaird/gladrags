// Generate (or reuse) an outfit's "wearing it" preview. Round 2 route
// contract from foundations; outfit-engine builds the real one (P2).
// See docs/CONTRACTS.md section 12 and PreviewResponseSchema.
//
// STUB: mock mode only (src/lib/mocks/previews.ts); not_implemented
// otherwise until outfit-engine replaces it. The real route:
//  1. requireUser; load the outfit (not_found if it isn't the user's).
//  2. Read user_settings.model_preset_id; none → needsPresetError() (bad_request).
//  3. previewCacheKey({ presetId, itemIds, gaps }) with the outfit's current gaps.
//  4. With ?refresh=true, assertCanStart("outfit_preview") first, so a
//     refresh that can't run changes nothing.
//  5. claim_outfit_preview (admin client). existing / reused / wait /
//     unavailable: return the outfit (remove released_image_key from
//     storage). generate: reserveAction("outfit_preview") (on a cap or
//     pause, finish the row as skipped and answer the error); build
//     ImageGenerationInput (item cut-outs or originals; gaps in words, or a
//     picked product's picture via safeFetch with allowRedirect =
//     shopImageUrlAllowed); meter image_generation; check with
//     inspectGeneratedImage then checkGeneratedPreviewImage; retry once;
//     store as WebP in the previews bucket (padded to exactly 2:3 if need
//     be); then finish_outfit_preview (ready, or failed with a reason).
//     ok false: delete the image just stored. Remove every
//     released_image_keys entry from storage. Return the outfit.
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
