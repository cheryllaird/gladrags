/**
 * The inbound email service, behind an interface so it can be swapped
 * (spec: "Order email import ... behind an interface"). Implementations
 * (one per provider, e.g. Postmark inbound, or a Cloudflare Email Routing
 * Worker posting JSON) are built by link-import in this folder.
 *
 * The webhook route (POST /api/inbound/email) calls `verify` on the raw
 * body before anything else, then `parse`, then validates the result with
 * InboundEmailSchema from src/contracts/email.ts.
 */
import "server-only";

export interface InboundWebhookRequest {
  headers: Headers;
  /** The body exactly as received (a signature covers these bytes). */
  rawBody: Uint8Array;
}

export interface InboundEmailProvider {
  /** e.g. "postmark". Chosen by INBOUND_EMAIL_PROVIDER. */
  readonly name: string;
  /**
   * True only if the request provably came from the provider: its
   * signature (an HMAC over the raw body, with a timestamp checked for
   * freshness), or the provider's credentials (e.g. HTTP Basic auth in the
   * webhook URL), compared in constant time with
   * INBOUND_EMAIL_WEBHOOK_SECRET. Never throws for a bad signature.
   */
  verify(request: InboundWebhookRequest): boolean | Promise<boolean>;
  /**
   * The provider's body mapped onto the normalised email shape (validate
   * the result with InboundEmailSchema). Drops attachments. Throws if the
   * body isn't the provider's format.
   */
  parse(rawBody: Uint8Array): unknown;
}
