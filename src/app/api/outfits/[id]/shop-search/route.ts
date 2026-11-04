// "Find in my shops" for an outfit's gaps (owner: outfit-engine). See
// docs/CONTRACTS.md section 5 and src/lib/outfits/shop-search.ts.
//
// Loads the outfit (not_found if it isn't the user's; bad_request if it has
// no gaps), checks and counts the daily shop search cap, makes one Gemini
// call with Google Search grounding for all the gaps (metered as
// shop_grounding), keeps only links on the user's favourite shops, confirms
// each page through the add-by-link fetcher, and stores up to three
// products per gap on the outfit. Mock mode: canned products, no network.
import { IdParamsSchema, ShopSearchResponseSchema } from "@/contracts";
import { jsonResponse, parseRouteParams, withApiHandler } from "@/lib/api/http";
import { requireUser } from "@/lib/auth/session";
import { getShopSearchService } from "@/lib/outfits";

interface Context {
  params: Promise<{ id: string }>;
}

/** A grounded search (up to two attempts) plus the page checks, inside a minute. */
export const maxDuration = 60;

export const POST = withApiHandler(async (_request, { params }: Context) => {
  const user = await requireUser();
  const { id } = await parseRouteParams(params, IdParamsSchema);
  const service = await getShopSearchService();
  return jsonResponse(ShopSearchResponseSchema, { outfit: await service.search(user.id, id) });
});
