// The inbound email service's webhook: a forwarded order email arrives
// here (route contract from foundations, milestone 5; built by
// link-import). See docs/CONTRACTS.md section 5, "Order emails".
//
// NOT a signed-in route: no session cookie is involved, and the proxy
// skips session handling for /api/inbound/ (src/proxy.ts). Its only
// authentication is the provider's signature or credentials, checked
// against INBOUND_EMAIL_WEBHOOK_SECRET in constant time over the raw body
// BEFORE anything is parsed. withApiHandler's cross-site check still runs
// and passes: server-to-server posts send no Origin or Sec-Fetch-Site.
// Nothing here may act on a browser session, so CSRF doesn't apply.
//
// The real version (link-import):
// 1. Refuse bodies over INBOUND_WEBHOOK_MAX_BYTES; verify the signature
//    (401 unauthorized if it fails); parse with the provider adapter into
//    InboundEmailSchema (400 if it can't).
// 2. Find the user from the token in a recipient address (tokenFromAddress
//    with getForwardingAddressConfig(); look it up with the admin client).
//    Unknown token: answer { received: true } and record nothing.
// 3. Skip a redelivery (same user and message_hash).
// 4. judgeInboundEmail(email, user's sign-in address). Refused: record a
//    failed email_imports row with its error code, nothing else.
// 5. reserveAction(user, "email_import"), then extract line items with the
//    model (OrderEmailModelOutputSchema, metered as "email_extraction"),
//    then for each line: fetch the image (the email's image link, else the
//    product page via the add-by-link fetcher), store it, tag it, count an
//    item_ingest, and save it with source "email" and needs_review = true
//    (or a placeholder image and needs_photo = true when there's no usable
//    picture). Stop at the daily item cap (skippedCount, error daily_cap_reached).
// 6. Update the email_imports row (status, counts, shop name, order date)
//    and drop the email. Always answer { received: true } once the
//    signature checks out, so the service doesn't retry; a 5xx makes it retry.
//
// Mock mode: the body is InboundEmailSchema JSON, with no signature. An
// email to the mock user's forwarding address from mock.user@gladrags.test
// with passing checks adds two "to review" items (one needing a photo).
import { InboundEmailSchema, InboundEmailWebhookResponseSchema, INBOUND_WEBHOOK_MAX_BYTES, judgeInboundEmail, tokenFromAddress } from "@/contracts";
import { ApiException } from "@/lib/api/errors";
import { jsonResponse, withApiHandler } from "@/lib/api/http";
import { MOCK_USER } from "@/lib/auth/session";
import { isMockMode } from "@/lib/env";
import { getForwardingAddressConfig, getInboundWebhookSecret } from "@/lib/env.server";
import * as mock from "@/lib/mocks/store";
import { getUsageGuard } from "@/lib/usage";
import { CapReachedError } from "@/lib/usage/errors";

/** Extraction plus several image fetches and tagging calls. */
export const maxDuration = 60;

const received = () => jsonResponse(InboundEmailWebhookResponseSchema, { received: true });

export const POST = withApiHandler(async (request) => {
  if (!isMockMode()) {
    getInboundWebhookSecret(); // 500 server_misconfigured until the secret is set
    throw new ApiException("not_implemented", "Order email import isn't built yet");
  }

  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > INBOUND_WEBHOOK_MAX_BYTES) {
    throw new ApiException("bad_request", "That email is too large");
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new ApiException("bad_request", "The request body must be JSON");
  }
  const parsed = InboundEmailSchema.safeParse(json);
  if (!parsed.success) throw new ApiException("bad_request", "That isn't an email the app can read");
  const email = parsed.data;

  const config = getForwardingAddressConfig();
  const token = config ? email.to.map((address) => tokenFromAddress(address, config)).find((t) => t !== null) : null;
  if (!token || token !== mock.getSettings().forwardingToken) return received();

  const verdict = judgeInboundEmail(email, MOCK_USER.email);
  if (!verdict.accepted) {
    mock.addFailedEmailImport(email.receivedAt, verdict.error);
    return received();
  }
  try {
    await getUsageGuard().reserveAction(MOCK_USER.id, "email_import");
  } catch (error) {
    if (!(error instanceof CapReachedError)) throw error;
    mock.addFailedEmailImport(email.receivedAt, error.cap === "monthly_ai_spend" ? "ai_paused" : "daily_cap_reached");
    return received();
  }
  mock.addMockEmailImport(email.receivedAt);
  return received();
});
