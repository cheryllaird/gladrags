// Give an item a real photo, for an order-email item saved without a
// usable picture (needsPhoto). Owner: ingestion. See docs/CONTRACTS.md
// section 5 and src/lib/ingestion/item-images.ts. The tags are kept (no
// re-tagging), so no AI and no cap; the item goes back to "to review".
//
// In mock mode it validates the upload and updates the in-memory mock
// wardrobe instead.
import { IdParamsSchema, ItemResponseSchema } from "@/contracts";
import { notFound } from "@/lib/api/errors";
import { jsonResponse, parseRouteParams, withApiHandler } from "@/lib/api/http";
import { parsePhotoReplaceUpload } from "@/lib/api/upload";
import { requireUser } from "@/lib/auth/session";
import { isMockMode } from "@/lib/env";
import { getItemImageDeps } from "@/lib/ingestion/deps";
import { replaceItemPhoto } from "@/lib/ingestion/item-images";
import * as mock from "@/lib/mocks/store";

interface Context {
  params: Promise<{ id: string }>;
}

export const PUT = withApiHandler(async (request, { params }: Context) => {
  const user = await requireUser();
  const { id } = await parseRouteParams(params, IdParamsSchema);
  const photo = await parsePhotoReplaceUpload(request);
  if (isMockMode()) {
    const item = mock.replaceItemPhoto(id);
    if (!item) throw notFound("That item");
    return jsonResponse(ItemResponseSchema, { item });
  }
  const item = await replaceItemPhoto(await getItemImageDeps(), user.id, id, photo);
  return jsonResponse(ItemResponseSchema, { item });
});
