// Wardrobe items: list and save (owner: ingestion). See docs/CONTRACTS.md
// section 5 and src/lib/ingestion/wardrobe.ts. In mock mode these serve the
// in-memory mock wardrobe instead.
import { CreateItemRequestSchema, ItemListQuerySchema, ItemListResponseSchema, ItemResponseSchema, imageKeyBelongsTo } from "@/contracts";
import { ApiException } from "@/lib/api/errors";
import { jsonResponse, parseJsonBody, parseSearchParams, withApiHandler } from "@/lib/api/http";
import { requireUser } from "@/lib/auth/session";
import { isMockMode } from "@/lib/env";
import { getWardrobeDeps } from "@/lib/ingestion/deps";
import { createWardrobeItem, listWardrobe } from "@/lib/ingestion/wardrobe";
import * as mock from "@/lib/mocks/store";

/** List the wardrobe, newest first, optionally filtered. */
export const GET = withApiHandler(async (request) => {
  const user = await requireUser();
  const query = parseSearchParams(request, ItemListQuerySchema);
  const items = isMockMode() ? mock.listItems(query) : await listWardrobe(await getWardrobeDeps(), user.id, query);
  return jsonResponse(ItemListResponseSchema, { items });
});

/** Save a reviewed draft as a wardrobe item. */
export const POST = withApiHandler(async (request) => {
  const user = await requireUser();
  const body = await parseJsonBody(request, CreateItemRequestSchema);
  if (isMockMode()) {
    const keys = [body.originalImageKey, body.cutoutImageKey].filter((k): k is string => k !== null);
    if (!keys.every((key) => imageKeyBelongsTo(key, user.id))) {
      throw new ApiException("bad_request", "Those images don't belong to you");
    }
    return jsonResponse(ItemResponseSchema, { item: mock.createItem(body) }, { status: 201 });
  }
  const item = await createWardrobeItem(await getWardrobeDeps(), user.id, body);
  return jsonResponse(ItemResponseSchema, { item }, { status: 201 });
});
