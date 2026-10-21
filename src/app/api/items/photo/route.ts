// STUB (owner: ingestion). Validates the upload and the daily cap, then
// returns a mock draft in mock mode. See docs/CONTRACTS.md.
//
// The real version: check dimensions (ServerImageProcessor.inspect +
// checkImage), strip EXIF from the original and the cut-out, store both in
// the private buckets, tag the cut-out if present (else the original) with
// callWithValidation (null tags if it fails twice), record the Gemini cost,
// and return signed URLs.
import { ItemDraftResponseSchema } from "@/contracts";
import { jsonResponse, withApiHandler } from "@/lib/api/http";
import { assertMockModeForStub } from "@/lib/api/stub";
import { parsePhotoUpload } from "@/lib/api/upload";
import { requireUser } from "@/lib/auth/session";
import * as mock from "@/lib/mocks/store";
import { getUsageGuard } from "@/lib/usage";

export const POST = withApiHandler(async (request) => {
  const user = await requireUser();
  const upload = await parsePhotoUpload(request);
  assertMockModeForStub("POST /api/items/photo");

  const usage = getUsageGuard();
  await usage.assertCanStart(user.id, "item_ingest");
  await usage.recordAction(user.id, "item_ingest");

  const draft = mock.createDraft({
    source: upload.sourceUrl ? "link" : "photo",
    sourceUrl: upload.sourceUrl ?? null,
    hasCutout: upload.cutout !== null,
  });
  return jsonResponse(ItemDraftResponseSchema, { draft });
});
