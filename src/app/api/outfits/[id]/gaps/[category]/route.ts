// Pick a shop product for one of an outfit's gaps, or clear the pick
// (owner: outfit-engine). See docs/CONTRACTS.md section 5.
//
// The product is copied from the gap's stored shopResults (matching
// productUrl), so nothing the phone sends about the product is trusted.
// not_found if the outfit has no gap in that slot; bad_request if the link
// isn't one of its results. No AI, nothing counted.
import { ChooseGapProductRequestSchema, GapParamsSchema, OutfitResponseSchema } from "@/contracts";
import { jsonResponse, parseJsonBody, parseRouteParams, withApiHandler } from "@/lib/api/http";
import { requireUser } from "@/lib/auth/session";
import { getShopSearchService } from "@/lib/outfits";

interface Context {
  params: Promise<{ id: string; category: string }>;
}

export const PUT = withApiHandler(async (request, { params }: Context) => {
  const user = await requireUser();
  const { id, category } = await parseRouteParams(params, GapParamsSchema);
  const { productUrl } = await parseJsonBody(request, ChooseGapProductRequestSchema);
  const service = await getShopSearchService();
  return jsonResponse(OutfitResponseSchema, { outfit: await service.chooseProduct(user.id, id, category, productUrl) });
});
