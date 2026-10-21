// STUB (owner: wardrobe backend, via ingestion). Validates input against the
// contracts and serves mock data in mock mode. See docs/CONTRACTS.md.
import { DeletedResponseSchema, IdParamsSchema, ItemResponseSchema, UpdateItemRequestSchema } from "@/contracts";
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
  assertMockModeForStub("GET /api/items/[id]");
  const item = mock.getItem(id);
  if (!item) throw notFound("That item");
  return jsonResponse(ItemResponseSchema, { item });
});

/** Replace the item's tags. Marks tagsEdited. */
export const PATCH = withApiHandler(async (request, { params }: Context) => {
  await requireUser();
  const { id } = await parseRouteParams(params, IdParamsSchema);
  const body = await parseJsonBody(request, UpdateItemRequestSchema);
  assertMockModeForStub("PATCH /api/items/[id]");
  const item = mock.updateItemTags(id, body.tags);
  if (!item) throw notFound("That item");
  return jsonResponse(ItemResponseSchema, { item });
});

/** Delete the item, its images, and any outfits that used it. */
export const DELETE = withApiHandler(async (_request, { params }: Context) => {
  await requireUser();
  const { id } = await parseRouteParams(params, IdParamsSchema);
  assertMockModeForStub("DELETE /api/items/[id]");
  if (!mock.deleteItem(id)) throw notFound("That item");
  return jsonResponse(DeletedResponseSchema, { deleted: true });
});
