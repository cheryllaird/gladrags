// Real implementation (outfit-engine): one outfit, and save / like / reject.
// See docs/CONTRACTS.md.
import { IdParamsSchema, OutfitResponseSchema, UpdateOutfitStatusRequestSchema } from "@/contracts";
import { jsonResponse, parseJsonBody, parseRouteParams, withApiHandler } from "@/lib/api/http";
import { requireUser } from "@/lib/auth/session";
import { getOutfitService } from "@/lib/outfits";

interface Context {
  params: Promise<{ id: string }>;
}

export const GET = withApiHandler(async (_request, { params }: Context) => {
  const user = await requireUser();
  const { id } = await parseRouteParams(params, IdParamsSchema);
  const service = await getOutfitService();
  return jsonResponse(OutfitResponseSchema, { outfit: await service.get(user.id, id) });
});

/**
 * Save, like or reject an outfit. Rejecting records an outfit_feedback row
 * (kind "reject", detail = the reason), and the outfit's item pairings
 * become "avoid" hints on later requests.
 */
export const PATCH = withApiHandler(async (request, { params }: Context) => {
  const user = await requireUser();
  const { id } = await parseRouteParams(params, IdParamsSchema);
  const body = await parseJsonBody(request, UpdateOutfitStatusRequestSchema);
  const service = await getOutfitService();
  return jsonResponse(OutfitResponseSchema, { outfit: await service.updateStatus(user.id, id, body) });
});
