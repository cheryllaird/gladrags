// STUB (owner: wardrobe backend, via ingestion). Validates input against the
// contracts and serves mock data in mock mode. See docs/CONTRACTS.md.
import { CreateItemRequestSchema, ItemListQuerySchema, ItemListResponseSchema, ItemResponseSchema, imageKeyBelongsTo } from "@/contracts";
import { ApiException } from "@/lib/api/errors";
import { jsonResponse, parseJsonBody, parseSearchParams, withApiHandler } from "@/lib/api/http";
import { assertMockModeForStub } from "@/lib/api/stub";
import { requireUser } from "@/lib/auth/session";
import * as mock from "@/lib/mocks/store";

/** List the wardrobe, optionally filtered. */
export const GET = withApiHandler(async (request) => {
  await requireUser();
  const query = parseSearchParams(request, ItemListQuerySchema);
  assertMockModeForStub("GET /api/items");
  return jsonResponse(ItemListResponseSchema, { items: mock.listItems(query) });
});

/** Save a reviewed draft as a wardrobe item. */
export const POST = withApiHandler(async (request) => {
  const user = await requireUser();
  const body = await parseJsonBody(request, CreateItemRequestSchema);
  const keys = [body.originalImageKey, body.cutoutImageKey].filter((k): k is string => k !== null);
  if (!keys.every((key) => imageKeyBelongsTo(key, user.id))) {
    throw new ApiException("bad_request", "Those images don't belong to you");
  }
  assertMockModeForStub("POST /api/items");
  return jsonResponse(ItemResponseSchema, { item: mock.createItem(body) }, { status: 201 });
});
