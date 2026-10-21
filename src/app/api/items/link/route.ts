// STUB (owner: link-import). Step 1 of 2 of adding by link. Validates the
// URL and checks the daily cap, then returns mock results in mock mode.
// See docs/CONTRACTS.md.
//
// The real version: fetch the page safely (http/https only, no private or
// internal addresses, timeouts, size limits), read Open Graph / JSON-LD
// product data, download the product image, resize to ≤ 1600 px and strip
// EXIF, store it in the originals bucket, insert a link_imports row with
// the source URL and product data, and return a short-lived signed URL
// (LINK_IMAGE_URL_TTL_SECONDS) so the phone can cut it out.
//
// Step 1 only CHECKS the item cap (no AI runs here); step 2, which tags,
// counts it.
//
// Mock behaviour, so the UI can show every state:
// - a hostname containing "blocked" -> needs_screenshot (fetch_blocked)
// - a hostname containing "nodata"  -> needs_screenshot (no_product_data)
// - a hostname containing "noimage" -> needs_screenshot (no_image)
// - mock-ai-paused / mock-daily-cap anywhere in the URL -> that error
// - anything else                   -> ok (mock-no-tags in the URL makes
//   step 2 return suggestedTags: null)
import { LinkImportRequestSchema, LinkImportResponseSchema, LinkProductSchema, type LinkImportResponse } from "@/contracts";
import { jsonResponse, parseJsonBody, withApiHandler } from "@/lib/api/http";
import { assertMockModeForStub } from "@/lib/api/stub";
import { requireUser } from "@/lib/auth/session";
import { throwIfCapMarker } from "@/lib/mocks/markers";
import * as mock from "@/lib/mocks/store";
import { getUsageGuard } from "@/lib/usage";

const SCREENSHOT_MESSAGE = "We couldn't read that page. Take a screenshot of the product and upload it instead.";

const MOCK_FAILURES = [
  ["blocked", "fetch_blocked"],
  ["nodata", "no_product_data"],
  ["noimage", "no_image"],
] as const;

export const POST = withApiHandler(async (request) => {
  const user = await requireUser();
  const { url } = await parseJsonBody(request, LinkImportRequestSchema);
  assertMockModeForStub("POST /api/items/link");
  throwIfCapMarker([url], "item_ingest");

  await getUsageGuard().assertCanStart(user.id, "item_ingest");

  const host = new URL(url).hostname;
  const failure = MOCK_FAILURES.find(([marker]) => host.includes(marker));
  let response: LinkImportResponse;
  if (failure) {
    response = { status: "needs_screenshot", reason: failure[1], sourceUrl: url, message: SCREENSHOT_MESSAGE };
  } else {
    // The real route parses scraped text with LinkProductSchema too.
    const product = LinkProductSchema.parse({ title: "Striped linen shirt", brand: "Example Co", colour: "Navy/White" });
    response = { status: "ok", sourceUrl: url, ...mock.storeLinkImport(user.id, url, product), product };
  }
  return jsonResponse(LinkImportResponseSchema, response);
});
