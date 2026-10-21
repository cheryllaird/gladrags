// STUB (owner: link-import, using ingestion's tagging). Step 2 of 2 of
// adding by link: attach the phone-made cut-out (optional) and tag the item.
// See docs/CONTRACTS.md.
//
// The real version:
// 1. Check the daily cap (assertCanStart "item_ingest").
// 2. Claim the import in ONE statement, so it can only be used once:
//      update link_imports set tagged_at = now()
//      where original_image_key = meta.originalImageKey and user_id = user.id
//        and tagged_at is null and created_at > now() - LINK_IMPORT_TTL_SECONDS
//      returning source_url, product
//    No row: not_found (expired, already used, or not theirs).
// 3. Count the item (recordAction "item_ingest"): tagging happens here.
// 4. Check the cut-out (dimensions, PNG with alpha), strip EXIF, store it.
// 5. Tag the cut-out (else the original) using the STORED product data as
//    hints, record the Gemini cost, and return the draft.
// The client's meta is only the image key; never trust echoed product data.
import { ItemDraftResponseSchema } from "@/contracts";
import { ApiException } from "@/lib/api/errors";
import { jsonResponse, withApiHandler } from "@/lib/api/http";
import { assertMockModeForStub } from "@/lib/api/stub";
import { parseLinkCutoutUpload } from "@/lib/api/upload";
import { requireUser } from "@/lib/auth/session";
import { MOCK_MARKERS, hasMarker, throwIfCapMarker } from "@/lib/mocks/markers";
import * as mock from "@/lib/mocks/store";
import { getUsageGuard } from "@/lib/usage";

export const POST = withApiHandler(async (request) => {
  const user = await requireUser();
  const { meta, cutout } = await parseLinkCutoutUpload(request);
  assertMockModeForStub("POST /api/items/link/cutout");

  const usage = getUsageGuard();
  await usage.assertCanStart(user.id, "item_ingest");

  const linkImport = mock.claimLinkImport(user.id, meta.originalImageKey);
  if (!linkImport) {
    throw new ApiException(
      "not_found",
      "That link has expired or was already added. Paste the link again to start over.",
    );
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
});
