// Real implementation (outfit-engine): swap one item or apply typed
// guidance. Records an outfit_feedback row (swap or guidance), sends the
// previous outfit and the feedback to the model, and returns new outfits
// whose parentOutfitId is this outfit. Counts against the daily outfit cap.
// See docs/CONTRACTS.md.
import { IdParamsSchema, OutfitGenerationResponseSchema, RefineRequestSchema } from "@/contracts";
import { jsonResponse, parseJsonBody, parseRouteParams, withApiHandler } from "@/lib/api/http";
import { requireUser } from "@/lib/auth/session";
import { isMockMode } from "@/lib/env";
import { throwIfCapMarker } from "@/lib/mocks/markers";
import { getOutfitService } from "@/lib/outfits";

interface Context {
  params: Promise<{ id: string }>;
}

/** Two model calls plus thumbnails can take a while; allow up to a minute on Vercel. */
export const maxDuration = 60;

export const POST = withApiHandler(async (request, { params }: Context) => {
  const user = await requireUser();
  const { id } = await parseRouteParams(params, IdParamsSchema);
  const body = await parseJsonBody(request, RefineRequestSchema);
  if (isMockMode()) {
    throwIfCapMarker([body.kind === "guidance" ? body.text : null], "outfit_request");
  }
  const service = await getOutfitService();
  return jsonResponse(OutfitGenerationResponseSchema, await service.refine(user.id, id, body));
});
