// Add by link, step 2 of 2 (owner: link-import, using ingestion's checks
// and tagging). See docs/CONTRACTS.md section 5 and
// src/lib/link-import/finish-link.ts for the steps.
//
// The client's meta is only the step-1 image key; the source URL and
// product hints come from what the server stored in step 1. The cut-out is
// checked before the import is claimed, so a rejected cut-out doesn't use
// the import up. Each import can be tagged once.
//
// In mock mode it validates the upload and the caps, then returns a mock
// draft; mock-no-tags in the step-1 URL makes suggestedTags null.
import { ItemDraftResponseSchema } from "@/contracts";
import { ApiException } from "@/lib/api/errors";
import { jsonResponse, withApiHandler } from "@/lib/api/http";
import { parseLinkCutoutUpload, type LinkCutoutUpload } from "@/lib/api/upload";
import { requireUser, type SessionUser } from "@/lib/auth/session";
import { isMockMode } from "@/lib/env";
import { getLinkCutoutDeps } from "@/lib/link-import/deps";
import { finishLinkImport } from "@/lib/link-import/finish-link";
import { MOCK_MARKERS, hasMarker, throwIfCapMarker } from "@/lib/mocks/markers";
import * as mock from "@/lib/mocks/store";
import { getUsageGuard } from "@/lib/usage";

/** Cut-out checks, EXIF stripping and tagging (with Gemini's one retry). */
export const maxDuration = 60;

export const POST = withApiHandler(async (request) => {
  const user = await requireUser();
  const upload = await parseLinkCutoutUpload(request);
  if (isMockMode()) return mockLinkCutout(user, upload);

  const draft = await finishLinkImport(getLinkCutoutDeps(), user.id, upload);
  return jsonResponse(ItemDraftResponseSchema, { draft });
});

async function mockLinkCutout(user: SessionUser, { meta, cutout }: LinkCutoutUpload) {
  const usage = getUsageGuard();
  await usage.assertCanStart(user.id, "item_ingest");

  const linkImport = mock.claimLinkImport(user.id, meta.originalImageKey);
  if (!linkImport) {
    throw new ApiException("not_found", "That link has expired or was already added. Paste the link again to start over.");
  }
  throwIfCapMarker([linkImport.sourceUrl], "item_ingest");
  await usage.recordAction(user.id, "item_ingest");

  const draft = mock.createDraft({
    source: "link",
    sourceUrl: linkImport.sourceUrl,
    hasCutout: cutout !== null,
    originalImageKey: meta.originalImageKey,
    taggingFails: hasMarker([linkImport.sourceUrl], MOCK_MARKERS.noTags),
  });
  return jsonResponse(ItemDraftResponseSchema, { draft });
}
