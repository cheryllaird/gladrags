// Store the cut-out the phone made the first time a collage needed this
// item (owner: ingestion). See docs/CONTRACTS.md section 5 and
// src/lib/ingestion/item-images.ts. No AI, so no cap.
//
// In mock mode it validates the upload and updates the in-memory mock
// wardrobe instead.
import { IdParamsSchema, ItemResponseSchema } from "@/contracts";
import { notFound } from "@/lib/api/errors";
import { jsonResponse, parseRouteParams, withApiHandler } from "@/lib/api/http";
import { parseCutoutUpload } from "@/lib/api/upload";
import { requireUser } from "@/lib/auth/session";
import { isMockMode } from "@/lib/env";
import { getItemImageDeps } from "@/lib/ingestion/deps";
import { setItemCutout } from "@/lib/ingestion/item-images";
import * as mock from "@/lib/mocks/store";

interface Context {
  params: Promise<{ id: string }>;
}

export const PUT = withApiHandler(async (request, { params }: Context) => {
  const user = await requireUser();
  const { id } = await parseRouteParams(params, IdParamsSchema);
  const cutout = await parseCutoutUpload(request);
  if (isMockMode()) {
    const item = mock.setItemCutout(id);
    if (!item) throw notFound("That item");
    return jsonResponse(ItemResponseSchema, { item });
  }
  const item = await setItemCutout(await getItemImageDeps(), user.id, id, cutout);
  return jsonResponse(ItemResponseSchema, { item });
});
