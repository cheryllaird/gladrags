// STUB (owner: outfit-engine). Validates input and the daily cap, then
// returns naive mock outfits in mock mode. See docs/CONTRACTS.md.
import {
  OutfitGenerationResponseSchema,
  OutfitListQuerySchema,
  OutfitListResponseSchema,
  OutfitRequestSchema,
} from "@/contracts";
import { notFound } from "@/lib/api/errors";
import { jsonResponse, parseJsonBody, parseSearchParams, withApiHandler } from "@/lib/api/http";
import { assertMockModeForStub } from "@/lib/api/stub";
import { requireUser } from "@/lib/auth/session";
import { throwIfCapMarker } from "@/lib/mocks/markers";
import * as mock from "@/lib/mocks/store";
import { getUsageGuard } from "@/lib/usage";

/** List outfits, e.g. ?status=saved for the saved outfits screen. Newest first. */
export const GET = withApiHandler(async (request) => {
  await requireUser();
  const { status } = parseSearchParams(request, OutfitListQuerySchema);
  assertMockModeForStub("GET /api/outfits");
  return jsonResponse(OutfitListResponseSchema, { outfits: mock.listOutfits(status) });
});

/** Ask for outfits for a style or occasion, optionally around one item. */
export const POST = withApiHandler(async (request) => {
  const user = await requireUser();
  const body = await parseJsonBody(request, OutfitRequestSchema);
  assertMockModeForStub("POST /api/outfits");

  if (body.anchorItemId && !mock.getItem(body.anchorItemId)) throw notFound("That item");
  throwIfCapMarker([body.guidance, body.style.kind === "custom" ? body.style.text : null], "outfit_request");

  const usage = getUsageGuard();
  await usage.assertCanStart(user.id, "outfit_request");
  await usage.recordAction(user.id, "outfit_request");

  return jsonResponse(OutfitGenerationResponseSchema, mock.generateOutfits(body));
});
