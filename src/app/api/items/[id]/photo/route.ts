// Give an item a real photo: for an order-email item saved without a
// usable picture (needsPhoto). Owner: ingestion; route contract from
// foundations, milestone 5. See docs/CONTRACTS.md section 5.
//
// Stub: validates the upload and serves mock data in mock mode only.
// The real version must check the photo like add-by-photo (dimensions,
// EXIF stripping), store it, replace items.original_image_key, remove any
// cut-out, clear needs_photo, set needs_review, and delete the old images.
// No AI and no cap.
import { IdParamsSchema, ItemResponseSchema } from "@/contracts";
import { notFound } from "@/lib/api/errors";
import { jsonResponse, parseRouteParams, withApiHandler } from "@/lib/api/http";
import { assertMockModeForStub } from "@/lib/api/stub";
import { parsePhotoReplaceUpload } from "@/lib/api/upload";
import { requireUser } from "@/lib/auth/session";
import * as mock from "@/lib/mocks/store";

interface Context {
  params: Promise<{ id: string }>;
}

export const PUT = withApiHandler(async (request, { params }: Context) => {
  await requireUser();
  const { id } = await parseRouteParams(params, IdParamsSchema);
  await parsePhotoReplaceUpload(request);
  assertMockModeForStub("Adding a photo to an item");
  const item = mock.replaceItemPhoto(id);
  if (!item) throw notFound("That item");
  return jsonResponse(ItemResponseSchema, { item });
});
