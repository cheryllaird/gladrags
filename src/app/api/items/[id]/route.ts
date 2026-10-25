// One wardrobe item: read, edit tags, delete (owner: ingestion). See
// docs/CONTRACTS.md section 5 and src/lib/ingestion/wardrobe.ts. In mock
// mode these use the in-memory mock wardrobe instead.
import { DeletedResponseSchema, IdParamsSchema, ItemResponseSchema, UpdateItemRequestSchema } from "@/contracts";
import { notFound } from "@/lib/api/errors";
import { jsonResponse, parseJsonBody, parseRouteParams, withApiHandler } from "@/lib/api/http";
import { requireUser } from "@/lib/auth/session";
import { isMockMode } from "@/lib/env";
import { getWardrobeDeps } from "@/lib/ingestion/deps";
import { deleteWardrobeItem, getWardrobeItem, updateWardrobeItemTags } from "@/lib/ingestion/wardrobe";
import * as mock from "@/lib/mocks/store";

interface Context {
  params: Promise<{ id: string }>;
}

export const GET = withApiHandler(async (_request, { params }: Context) => {
  const user = await requireUser();
  const { id } = await parseRouteParams(params, IdParamsSchema);
  if (isMockMode()) {
    const item = mock.getItem(id);
    if (!item) throw notFound("That item");
    return jsonResponse(ItemResponseSchema, { item });
  }
  const item = await getWardrobeItem(await getWardrobeDeps(), user.id, id);
  return jsonResponse(ItemResponseSchema, { item });
});

/** Replace the item's tags. Marks tagsEdited. */
export const PATCH = withApiHandler(async (request, { params }: Context) => {
  const user = await requireUser();
  const { id } = await parseRouteParams(params, IdParamsSchema);
  const body = await parseJsonBody(request, UpdateItemRequestSchema);
  if (isMockMode()) {
    const item = mock.updateItemTags(id, body.tags);
    if (!item) throw notFound("That item");
    return jsonResponse(ItemResponseSchema, { item });
  }
  const item = await updateWardrobeItemTags(await getWardrobeDeps(), user.id, id, body.tags);
  return jsonResponse(ItemResponseSchema, { item });
});

/** Delete the item, its images, and any outfits that used it. */
export const DELETE = withApiHandler(async (_request, { params }: Context) => {
  const user = await requireUser();
  const { id } = await parseRouteParams(params, IdParamsSchema);
  if (isMockMode()) {
    if (!mock.deleteItem(id)) throw notFound("That item");
  } else {
    await deleteWardrobeItem(await getWardrobeDeps(), user.id, id);
  }
  return jsonResponse(DeletedResponseSchema, { deleted: true });
});
