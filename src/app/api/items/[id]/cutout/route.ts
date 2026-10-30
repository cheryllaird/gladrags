// Store the cut-out the phone made the first time a collage needed this
// item (owner: ingestion; route contract from foundations, milestone 5).
// See docs/CONTRACTS.md section 5.
//
// Stub: validates the upload and serves mock data in mock mode only.
// The real version must also check the cut-out against the item's original
// (no wider or taller, really transparent: checkUploadedCutout), strip
// EXIF, store it in the cutouts bucket, set items.cutout_image_key, and
// delete any cut-out it replaces.
import { IdParamsSchema, ItemResponseSchema } from "@/contracts";
import { notFound } from "@/lib/api/errors";
import { jsonResponse, parseRouteParams, withApiHandler } from "@/lib/api/http";
import { assertMockModeForStub } from "@/lib/api/stub";
import { parseCutoutUpload } from "@/lib/api/upload";
import { requireUser } from "@/lib/auth/session";
import * as mock from "@/lib/mocks/store";

interface Context {
  params: Promise<{ id: string }>;
}

export const PUT = withApiHandler(async (request, { params }: Context) => {
  await requireUser();
  const { id } = await parseRouteParams(params, IdParamsSchema);
  await parseCutoutUpload(request);
  assertMockModeForStub("Saving a cut-out");
  const item = mock.setItemCutout(id);
  if (!item) throw notFound("That item");
  return jsonResponse(ItemResponseSchema, { item });
});
