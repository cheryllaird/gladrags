// "Find in my shops" for an outfit's gaps (owner: outfit-engine; route
// contract from foundations, milestone 5). See docs/CONTRACTS.md section 5.
//
// Stub: serves mock data in mock mode only. The real version:
// 1. Loads the outfit (not_found if it isn't the user's); bad_request if it
//    has no gaps, or the user has no favourite shops.
// 2. usage.assertCanStart(user, "shop_search"), then reserveAction (cap
//    shop_searches_per_day; refused while AI is paused).
// 3. One Gemini call with Google Search grounding for all the gaps
//    (ShopSearchProvider, metered as "shop_grounding"), validated with
//    ShopSearchModelOutputSchema through callWithValidation.
// 4. Keeps candidate links on the favourite shops only (shopForUrl), fetches
//    each through the add-by-link fetcher (safe-fetch) to confirm it and
//    read the title, price and image, and keeps up to three per gap.
// 5. Stores them on the outfit (gaps[].shopResults, searchedAt), keeping
//    any chosen shopProduct, and returns the outfit.
import { IdParamsSchema, ShopSearchResponseSchema } from "@/contracts";
import { ApiException, notFound } from "@/lib/api/errors";
import { jsonResponse, parseRouteParams, withApiHandler } from "@/lib/api/http";
import { assertMockModeForStub } from "@/lib/api/stub";
import { requireUser } from "@/lib/auth/session";
import * as mock from "@/lib/mocks/store";
import { getUsageGuard } from "@/lib/usage";

interface Context {
  params: Promise<{ id: string }>;
}

/** A grounded search plus up to nine page checks. */
export const maxDuration = 60;

export const POST = withApiHandler(async (_request, { params }: Context) => {
  const user = await requireUser();
  const { id } = await parseRouteParams(params, IdParamsSchema);
  assertMockModeForStub("Finding gap items in your shops");

  const outfit = mock.getOutfit(id);
  if (!outfit) throw notFound("That outfit");
  if (outfit.gaps.length === 0) throw new ApiException("bad_request", "This outfit has nothing to find: every piece is from your wardrobe");
  await getUsageGuard().reserveAction(user.id, "shop_search");
  return jsonResponse(ShopSearchResponseSchema, { outfit: mock.mockShopSearch(id)! });
});
