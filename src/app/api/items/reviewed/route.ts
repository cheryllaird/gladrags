// "Confirm all" in the review list: mark several items reviewed at once
// (owner: ingestion; route contract from foundations, milestone 5). See
// docs/CONTRACTS.md section 5.
//
// Stub: serves mock data in mock mode only. The real version is one update
// of the user's own rows (`needs_review = false where user_id = ... and
// id in (...)`), returning how many matched.
import { MarkItemsReviewedRequestSchema, MarkItemsReviewedResponseSchema } from "@/contracts";
import { jsonResponse, parseJsonBody, withApiHandler } from "@/lib/api/http";
import { assertMockModeForStub } from "@/lib/api/stub";
import { requireUser } from "@/lib/auth/session";
import * as mock from "@/lib/mocks/store";

export const POST = withApiHandler(async (request) => {
  await requireUser();
  const { itemIds } = await parseJsonBody(request, MarkItemsReviewedRequestSchema);
  assertMockModeForStub("Confirming several items");
  return jsonResponse(MarkItemsReviewedResponseSchema, { updated: mock.markItemsReviewed(itemIds) });
});
