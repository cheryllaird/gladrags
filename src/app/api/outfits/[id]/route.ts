// STUB (owner: outfit-engine). Validates input and serves mock data in mock
// mode. See docs/CONTRACTS.md.
import { IdParamsSchema, OutfitResponseSchema, UpdateOutfitStatusRequestSchema } from "@/contracts";
import { notFound } from "@/lib/api/errors";
import { jsonResponse, parseJsonBody, parseRouteParams, withApiHandler } from "@/lib/api/http";
import { assertMockModeForStub } from "@/lib/api/stub";
import { requireUser } from "@/lib/auth/session";
import * as mock from "@/lib/mocks/store";

interface Context {
  params: Promise<{ id: string }>;
}

export const GET = withApiHandler(async (_request, { params }: Context) => {
  await requireUser();
  const { id } = await parseRouteParams(params, IdParamsSchema);
  assertMockModeForStub("GET /api/outfits/[id]");
  const outfit = mock.getOutfit(id);
  if (!outfit) throw notFound("That outfit");
  return jsonResponse(OutfitResponseSchema, { outfit });
});

/**
 * Save, like or reject an outfit. The real version also writes an
 * outfit_feedback row (kind "reject", detail = reason) on rejection.
 */
export const PATCH = withApiHandler(async (request, { params }: Context) => {
  await requireUser();
  const { id } = await parseRouteParams(params, IdParamsSchema);
  const body = await parseJsonBody(request, UpdateOutfitStatusRequestSchema);
  assertMockModeForStub("PATCH /api/outfits/[id]");
  const outfit = mock.setOutfitStatus(id, body.status);
  if (!outfit) throw notFound("That outfit");
  return jsonResponse(OutfitResponseSchema, { outfit });
});
