// Add by link, step 1 of 2 (owner: link-import). See docs/CONTRACTS.md
// section 5 and src/lib/link-import/import-link.ts for the steps.
//
// The server fetches the page itself, so this is the app's riskiest route:
// src/lib/link-import/safe-fetch.ts refuses private and internal addresses
// (re-checked on every redirect and pinned against DNS rebinding), caps
// time and size, and sends no cookies.
//
// Step 1 only CHECKS the item cap (no AI runs here); step 2, which tags,
// counts it.
//
// Mock mode (GLADRAGS_MOCK_MODE=true) never touches the network, so the UI
// can show every state:
// - a hostname containing "blocked" -> needs_screenshot (fetch_blocked)
// - a hostname containing "nodata"  -> needs_screenshot (no_product_data)
// - a hostname containing "noimage" -> needs_screenshot (no_image)
// - mock-ai-paused / mock-daily-cap anywhere in the URL -> that error
// - anything else                   -> ok (mock-no-tags in the URL makes
//   step 2 return suggestedTags: null)
import { LinkImportRequestSchema, LinkImportResponseSchema, LinkProductSchema, type LinkImportResponse } from "@/contracts";
import { jsonResponse, parseJsonBody, withApiHandler } from "@/lib/api/http";
import { requireUser, type SessionUser } from "@/lib/auth/session";
import { isMockMode } from "@/lib/env";
import { getLinkImportDeps } from "@/lib/link-import/deps";
import { importFromLink } from "@/lib/link-import/import-link";
import { throwIfCapMarker } from "@/lib/mocks/markers";
import * as mock from "@/lib/mocks/store";
import { getUsageGuard } from "@/lib/usage";

/** Page fetch (≤ 10 s) plus up to three image downloads (≤ 25 s together) and processing. */
export const maxDuration = 60;

export const POST = withApiHandler(async (request) => {
  const user = await requireUser();
  const { url } = await parseJsonBody(request, LinkImportRequestSchema);
  if (isMockMode()) return mockLinkImport(user, url);

  const response = await importFromLink(getLinkImportDeps(), user.id, url);
  return jsonResponse(LinkImportResponseSchema, response);
});

const MOCK_SCREENSHOT_MESSAGE = "We couldn't read that page. Take a screenshot of the product and upload it instead.";

const MOCK_FAILURES = [
  ["blocked", "fetch_blocked"],
  ["nodata", "no_product_data"],
  ["noimage", "no_image"],
] as const;

async function mockLinkImport(user: SessionUser, url: string) {
  throwIfCapMarker([url], "item_ingest");
  await getUsageGuard().assertCanStart(user.id, "item_ingest");

  const host = new URL(url).hostname;
  const failure = MOCK_FAILURES.find(([marker]) => host.includes(marker));
  let response: LinkImportResponse;
  if (failure) {
    response = { status: "needs_screenshot", reason: failure[1], sourceUrl: url, message: MOCK_SCREENSHOT_MESSAGE };
  } else {
    const product = LinkProductSchema.parse({ title: "Striped linen shirt", brand: "Example Co", colour: "Navy/White" });
    response = { status: "ok", sourceUrl: url, ...mock.storeLinkImport(user.id, url, product), product };
  }
  return jsonResponse(LinkImportResponseSchema, response);
}
