// STUB (owner: link-import, using ingestion's tagging). Step 2 of 2 of
// adding by link: attach the phone-made cut-out (optional) and tag the item.
// See docs/CONTRACTS.md.
//
// The real version: confirm meta.originalImageKey exists in the originals
// bucket and is the user's, check and strip the cut-out, store it, tag the
// cut-out (else the original) using meta.product as hints, record the
// Gemini cost, and return the draft. Doesn't count against the daily item
// cap again (step 1 did), but must respect the monthly AI pause.
import { ItemDraftResponseSchema, imageKeyBelongsTo } from "@/contracts";
import { ApiException } from "@/lib/api/errors";
import { jsonResponse, withApiHandler } from "@/lib/api/http";
import { assertMockModeForStub } from "@/lib/api/stub";
import { parseLinkCutoutUpload } from "@/lib/api/upload";
import { requireUser } from "@/lib/auth/session";
import * as mock from "@/lib/mocks/store";
import { getUsageGuard } from "@/lib/usage";

export const POST = withApiHandler(async (request) => {
  const user = await requireUser();
  const { meta, cutout } = await parseLinkCutoutUpload(request);
  if (!imageKeyBelongsTo(meta.originalImageKey, user.id)) {
    throw new ApiException("bad_request", "That image doesn't belong to you");
  }
  assertMockModeForStub("POST /api/items/link/cutout");

  await getUsageGuard().assertAiAvailable();

  const draft = mock.createDraft({
    source: "link",
    sourceUrl: meta.sourceUrl,
    hasCutout: cutout !== null,
    originalImageKey: meta.originalImageKey,
  });
  return jsonResponse(ItemDraftResponseSchema, { draft });
});
