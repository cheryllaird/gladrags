// Add by photo (owner: ingestion). See docs/CONTRACTS.md section 5 and
// src/lib/ingestion/add-photo.ts for the steps.
//
// In mock mode (GLADRAGS_MOCK_MODE=true) it validates the upload and the
// caps, then returns a mock draft, so the UI can be built without Supabase
// or Gemini. The mock markers in the file name trigger the error states.
import { ItemDraftResponseSchema } from "@/contracts";
import { jsonResponse, withApiHandler } from "@/lib/api/http";
import { parsePhotoUpload, type PhotoUpload } from "@/lib/api/upload";
import { requireUser, type SessionUser } from "@/lib/auth/session";
import { isMockMode } from "@/lib/env";
import { addItemFromPhoto } from "@/lib/ingestion/add-photo";
import { getPhotoIngestionDeps } from "@/lib/ingestion/deps";
import { MOCK_MARKERS, hasMarker, throwIfCapMarker } from "@/lib/mocks/markers";
import * as mock from "@/lib/mocks/store";
import { getUsageGuard } from "@/lib/usage";

/**
 * The upload, cut-out checks, EXIF stripping and tagging can take a few
 * seconds; give Gemini room for its one retry.
 */
export const maxDuration = 60;

export const POST = withApiHandler(async (request) => {
  const user = await requireUser();
  const upload = await parsePhotoUpload(request);
  if (isMockMode()) return mockPhotoDraft(user, upload);

  const draft = await addItemFromPhoto(getPhotoIngestionDeps(), user.id, upload);
  return jsonResponse(ItemDraftResponseSchema, { draft });
});

async function mockPhotoDraft(user: SessionUser, upload: PhotoUpload) {
  throwIfCapMarker([upload.original.name], "item_ingest");
  const usage = getUsageGuard();
  await usage.assertCanStart(user.id, "item_ingest");
  await usage.recordAction(user.id, "item_ingest");
  const draft = mock.createDraft({
    source: upload.sourceUrl ? "link" : "photo",
    sourceUrl: upload.sourceUrl ?? null,
    hasCutout: upload.cutout !== null,
    taggingFails: hasMarker([upload.original.name], MOCK_MARKERS.noTags),
  });
  return jsonResponse(ItemDraftResponseSchema, { draft });
}
