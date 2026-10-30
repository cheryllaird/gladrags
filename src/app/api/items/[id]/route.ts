// One wardrobe item: read, edit tags or confirm them, delete (owner:
// ingestion). See docs/CONTRACTS.md section 5 and
// src/lib/ingestion/wardrobe.ts. In mock mode these use the in-memory mock
// wardrobe instead.
import { DeletedResponseSchema, IdParamsSchema, ItemResponseSchema, UpdateItemRequestSchema } from "@/contracts";
import { ApiException, notFound } from "@/lib/api/errors";
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

/**
 * `{ tags }` replaces the tags and marks tagsEdited; `{ reviewed: true }`
 * confirms them as they are. Either way the item is no longer "to review".
 */
export const PATCH = withApiHandler(async (request, { params }: Context) => {
  const user = await requireUser();
  const { id } = await parseRouteParams(params, IdParamsSchema);
  const body = await parseJsonBody(request, UpdateItemRequestSchema);
  if (isMockMode()) {
    const item = mock.updateItem(id, body);
    if (!item) throw notFound("That item");
    return jsonResponse(ItemResponseSchema, { item });
  }
  // TODO(ingestion, milestone 5): clear needs_review on every PATCH, and
  // support { reviewed: true } on its own.
  if (!body.tags) throw new ApiException("not_implemented", "Confirming an item's tags isn't built yet");
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
