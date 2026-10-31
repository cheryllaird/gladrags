// Pick a shop product for one of an outfit's gaps, or clear the pick
// (owner: outfit-engine; route contract from foundations, milestone 5).
// See docs/CONTRACTS.md section 5.
//
// Stub: serves mock data in mock mode only. The real version copies the
// product from the gap's stored shopResults (matching productUrl), so
// nothing the phone sends about the product is trusted, and saves it as
// the gap's shopProduct.
import { ChooseGapProductRequestSchema, GapParamsSchema, OutfitResponseSchema } from "@/contracts";
import { ApiException, notFound } from "@/lib/api/errors";
import { jsonResponse, parseJsonBody, parseRouteParams, withApiHandler } from "@/lib/api/http";
import { assertMockModeForStub } from "@/lib/api/stub";
import { requireUser } from "@/lib/auth/session";
import * as mock from "@/lib/mocks/store";

interface Context {
  params: Promise<{ id: string; category: string }>;
}

export const PUT = withApiHandler(async (request, { params }: Context) => {
  await requireUser();
  const { id, category } = await parseRouteParams(params, GapParamsSchema);
  const { productUrl } = await parseJsonBody(request, ChooseGapProductRequestSchema);
  assertMockModeForStub("Choosing a shop product");

  const result = mock.chooseGapProduct(id, category, productUrl);
  if (result === null) throw notFound("That outfit");
  if (result === "no_gap") throw notFound("That gap");
  if (result === "not_a_result") {
    throw new ApiException("bad_request", "That product isn't one of the search results for this gap", {
      issues: [{ path: "productUrl", message: "Not one of this gap's results" }],
    });
  }
  return jsonResponse(OutfitResponseSchema, { outfit: result });
});
