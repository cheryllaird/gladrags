// The inbound email service's webhook: a forwarded order email arrives
// here (route contract from foundations, milestone 5; built by
// link-import). See docs/CONTRACTS.md section 5, "Order emails".
//
// NOT a signed-in route: no session cookie is involved, and the proxy
// skips session handling for /api/inbound/ (src/proxy.ts). Its only
// authentication is the provider's signature or credentials, checked
// against INBOUND_EMAIL_WEBHOOK_SECRET in constant time BEFORE anything is
// parsed (for Postmark: HTTP Basic credentials in the webhook URL; see
// src/lib/email/postmark.ts). withApiHandler's cross-site check still runs
// and passes: server-to-server posts send no Origin or Sec-Fetch-Site.
// Nothing here acts on a browser session, so CSRF doesn't apply.
//
// 1. Refuse bodies over INBOUND_WEBHOOK_MAX_BYTES without buffering them,
//    verify the credentials (401), have the adapter normalise the email and
//    check it against InboundEmailSchema (400).
// 2-5. Quick steps (src/lib/email/receive.ts): find the user by the
//    token, skip a redelivery, judge the sender and checks, count the
//    email against emails_per_day. Refused emails are recorded without
//    their content; an unknown token leaves no trace.
// Then answer { received: true } at once, and read the email and add its
// items after the response (src/lib/email/process.ts), within a time
// budget under maxDuration.
//
// Why after the response: reading the email takes one or two model calls,
// then each line needs its picture fetched and tagged, which together can
// take minutes for a big order, while email services wait only a short
// time for an answer and retry when they don't get one. Next's after()
// keeps the function running once the answer is sent (on Vercel, up to
// maxDuration). The trade-off: if the function is stopped part-way, the
// email is gone (it's never stored) and the import shows as failed after
// 15 minutes, rather than being retried by the service. Errors on our side
// BEFORE the answer (database down) still answer 5xx, so the service
// retries those.
//
// Mock mode: the body is InboundEmailSchema JSON, with no signature. An
// email to the mock user's forwarding address from mock.user@gladrags.test
// with passing checks adds two "to review" items (one needing a photo). A
// redelivery (same messageId) is skipped, as the real one is.
import { after } from "next/server";
import { InboundEmailSchema, InboundEmailWebhookResponseSchema, INBOUND_WEBHOOK_MAX_BYTES, judgeInboundEmail, tokenFromAddress } from "@/contracts";
import { ApiException } from "@/lib/api/errors";
import { jsonResponse, withApiHandler } from "@/lib/api/http";
import { MOCK_USER } from "@/lib/auth/session";
import { getEmailProcessingDeps } from "@/lib/email/deps";
import { processAcceptedEmail } from "@/lib/email/process";
import { getInboundEmailProvider } from "@/lib/email/providers";
import { receiveInboundEmail } from "@/lib/email/receive";
import { BodyTooLargeError, readBodyCapped } from "@/lib/email/webhook-request";
import { isMockMode } from "@/lib/env";
import { getForwardingAddressConfig } from "@/lib/env.server";
import * as mock from "@/lib/mocks/store";
import { getUsageGuard } from "@/lib/usage";
import { CapReachedError } from "@/lib/usage/errors";

/**
 * Seconds the function may run, the answer plus processing after it
 * (EMAIL_PROCESSING_BUDGET_MS is 240 s of this). 300 s is the most Vercel
 * allows on the Hobby plan with Fluid compute (the default for new projects).
 */
export const maxDuration = 300;

const received = () => jsonResponse(InboundEmailWebhookResponseSchema, { received: true });

async function readBody(request: Request): Promise<Uint8Array> {
  try {
    return await readBodyCapped(request, INBOUND_WEBHOOK_MAX_BYTES);
  } catch (error) {
    if (error instanceof BodyTooLargeError) throw new ApiException("bad_request", "That email is too large");
    throw error;
  }
}

export const POST = withApiHandler(async (request) => {
  if (isMockMode()) return mockInbound(await readBody(request));

  // 500 server_misconfigured until the secret and provider are set.
  const provider = getInboundEmailProvider();
  const rawBody = await readBody(request);
  if (!(await provider.verify({ headers: request.headers, rawBody }))) {
    throw new ApiException("unauthorized", "The webhook credentials are missing or wrong");
  }

  let normalised: unknown;
  try {
    normalised = provider.parse(rawBody);
  } catch {
    throw new ApiException("bad_request", "That isn't an email the app can read");
  }
  const parsed = InboundEmailSchema.safeParse(normalised);
  if (!parsed.success) throw new ApiException("bad_request", "That isn't an email the app can read");

  const deps = getEmailProcessingDeps();
  const accepted = await receiveInboundEmail(deps, parsed.data, getForwardingAddressConfig());
  if (accepted) after(() => processAcceptedEmail(deps, accepted));
  return received();
});

async function mockInbound(rawBody: Uint8Array) {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(rawBody));
  } catch {
    throw new ApiException("bad_request", "The request body must be JSON");
  }
  const parsed = InboundEmailSchema.safeParse(json);
  if (!parsed.success) throw new ApiException("bad_request", "That isn't an email the app can read");
  const email = parsed.data;

  const config = getForwardingAddressConfig();
  const token = config ? email.to.map((address) => tokenFromAddress(address, config)).find((t) => t !== null) : null;
  if (!token || token !== mock.getSettings().forwardingToken) return received();
  if (!mock.markEmailDelivered(email.messageId)) return received();

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
}
