// "Confirm all" in the review list: mark several items reviewed at once
// (owner: ingestion). See docs/CONTRACTS.md section 5. Item IDs that
// aren't the user's are ignored; `updated` counts the ones that were.
//
// In mock mode it updates the in-memory mock wardrobe instead.
import { MarkItemsReviewedRequestSchema, MarkItemsReviewedResponseSchema } from "@/contracts";
import { jsonResponse, parseJsonBody, withApiHandler } from "@/lib/api/http";
import { requireUser } from "@/lib/auth/session";
import { isMockMode } from "@/lib/env";
import { getWardrobeDeps } from "@/lib/ingestion/deps";
import { markWardrobeItemsReviewed } from "@/lib/ingestion/wardrobe";
import * as mock from "@/lib/mocks/store";

export const POST = withApiHandler(async (request) => {
  const user = await requireUser();
  const { itemIds } = await parseJsonBody(request, MarkItemsReviewedRequestSchema);
  const updated = isMockMode() ? mock.markItemsReviewed(itemIds) : await markWardrobeItemsReviewed(await getWardrobeDeps(), user.id, itemIds);
  return jsonResponse(MarkItemsReviewedResponseSchema, { updated });
});
