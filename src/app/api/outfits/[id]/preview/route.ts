// Generate (or reuse) an outfit's "wearing it" preview (owner:
// outfit-engine). See docs/CONTRACTS.md section 12 and
// src/lib/outfits/preview.ts for the flow: load the outfit and preset,
// work out the look, claim it (reuse, wait or generate), generate with
// the image model (counted, metered, checked, retried once), store as
// WebP in the previews bucket, finish, and return the outfit.
// Mock mode: src/lib/mocks/previews.ts (no model, no storage).
import { IdParamsSchema, PreviewRequestQuerySchema, PreviewResponseSchema } from "@/contracts";
import { jsonResponse, parseRouteParams, parseSearchParams, withApiHandler } from "@/lib/api/http";
import { requireUser } from "@/lib/auth/session";
import { isMockMode } from "@/lib/env";
import { mockPreview } from "@/lib/mocks/previews";
import { getPreviewService } from "@/lib/outfits";
import { getUsageGuard } from "@/lib/usage";

interface Context {
  params: Promise<{ id: string }>;
}

/**
 * Up to two image generations plus the input pictures and storing the
 * result (PREVIEW_ROUTE_BUDGET_MS, 80 s). Shorter than
 * PREVIEW_PENDING_STALE_SECONDS, so a pending preview is only taken over
 * once its request has certainly ended.
 */
export const maxDuration = 90;

export const POST = withApiHandler(async (request, { params }: Context) => {
  const user = await requireUser();
  const { id } = await parseRouteParams(params, IdParamsSchema);
  const { refresh } = parseSearchParams(request, PreviewRequestQuerySchema);
  if (isMockMode()) {
    return jsonResponse(PreviewResponseSchema, { outfit: await mockPreview(user.id, id, refresh, getUsageGuard()) });
  }
  const service = await getPreviewService();
  return jsonResponse(PreviewResponseSchema, { outfit: await service.preview(user.id, id, refresh) });
});
