// STUB (owner: outfit-engine). Validates input and the daily cap, then
// returns a revised mock set in mock mode. See docs/CONTRACTS.md.
//
// The real version records an outfit_feedback row (swap or guidance), sends
// the previous outfit and the feedback to the model, and returns new
// outfits whose parentOutfitId is this outfit.
import { IdParamsSchema, OutfitGenerationResponseSchema, RefineRequestSchema } from "@/contracts";
import { ApiException, notFound } from "@/lib/api/errors";
import { jsonResponse, parseJsonBody, parseRouteParams, withApiHandler } from "@/lib/api/http";
import { assertMockModeForStub } from "@/lib/api/stub";
import { requireUser } from "@/lib/auth/session";
import * as mock from "@/lib/mocks/store";
import { getUsageGuard } from "@/lib/usage";

interface Context {
  params: Promise<{ id: string }>;
}

export const POST = withApiHandler(async (request, { params }: Context) => {
  const user = await requireUser();
  const { id } = await parseRouteParams(params, IdParamsSchema);
  const body = await parseJsonBody(request, RefineRequestSchema);
  assertMockModeForStub("POST /api/outfits/[id]/refine");

  const outfit = mock.getOutfit(id);
  if (!outfit) throw notFound("That outfit");
  if (body.kind === "swap" && !outfit.itemIds.includes(body.itemId)) {
    throw new ApiException("bad_request", "That item isn't in this outfit", {
      issues: [{ path: "itemId", message: "Not in this outfit" }],
    });
  }

  const usage = getUsageGuard();
  await usage.assertCanStart(user.id, "outfit_request");
  await usage.recordAction(user.id, "outfit_request");

  const result = mock.refineOutfit(id, body);
  if (!result) throw notFound("That outfit");
  return jsonResponse(OutfitGenerationResponseSchema, result);
});
