/**
 * Adding items by forwarding order confirmation emails (spec: "Add by
 * forwarding order emails"): the forwarding address, the normalised email
 * an inbound email service hands the app, the acceptance rules, and the
 * email_imports records the user sees.
 */
import { z } from "zod";
import { IdSchema, TimestampSchema, emptyToNull, scrapedText } from "./common";

// ---------------------------------------------------------------------------
// Forwarding address
// ---------------------------------------------------------------------------

/**
 * The private part of a user's forwarding address: 32 lower-case hex
 * characters (122 random bits, from gen_random_uuid() in the database).
 * Lower case because email local parts are often lower-cased in transit.
 */
export const ForwardingTokenSchema = z.string().regex(/^[0-9a-f]{32}$/, { error: "Not a forwarding token" });
export type ForwardingToken = z.infer<typeof ForwardingTokenSchema>;

/**
 * Where forwarding addresses live, from the environment:
 * - INBOUND_EMAIL_DOMAIN, e.g. "in.gladrags.example" (required to show an address)
 * - INBOUND_EMAIL_PREFIX (optional), put before the token, e.g. "abc123+" for
 *   a service that gives one fixed mailbox with plus-addressing (Postmark's
 *   inbound address is "<hash>@inbound.postmarkapp.com", so the prefix is "<hash>+").
 */
export interface ForwardingAddressConfig {
  domain: string;
  prefix?: string;
}

/** The full forwarding address for a token: `${prefix}${token}@${domain}`. */
export function forwardingAddress(token: string, config: ForwardingAddressConfig): string {
  return `${config.prefix ?? ""}${token}@${config.domain}`.toLowerCase();
}

/**
 * The token in a recipient address, or null if the address isn't one of
 * ours (wrong domain, wrong prefix, or no valid token). Case-insensitive.
 */
export function tokenFromAddress(address: string, config: ForwardingAddressConfig): ForwardingToken | null {
  const at = address.lastIndexOf("@");
  if (at < 0) return null;
  const local = address.slice(0, at).toLowerCase();
  const domain = address.slice(at + 1).toLowerCase().replace(/\.$/, "");
  if (domain !== config.domain.toLowerCase()) return null;
  const prefix = (config.prefix ?? "").toLowerCase();
  if (!local.startsWith(prefix)) return null;
  const token = local.slice(prefix.length);
  return ForwardingTokenSchema.safeParse(token).success ? token : null;
}

// ---------------------------------------------------------------------------
// The inbound email, normalised
// ---------------------------------------------------------------------------

/** Most characters of text or HTML body kept from an email; the rest is cut off. */
export const INBOUND_EMAIL_LIMITS = { text: 100_000, html: 500_000, subject: 300, address: 320 } as const;

/**
 * Most bytes the inbound webhook accepts in one request. Order emails are
 * small; attachments aren't needed (the provider should be set to drop them).
 */
export const INBOUND_WEBHOOK_MAX_BYTES = 2 * 1024 * 1024;

/** An authentication result as the inbound email service reported it. */
export const AUTH_VERDICTS = ["pass", "fail", "softfail", "neutral", "none", "unknown"] as const;
export const AuthVerdictSchema = z.preprocess(
  (v) => (typeof v === "string" ? v.toLowerCase() : v),
  z.enum(AUTH_VERDICTS).catch("unknown"),
);
export type AuthVerdict = z.infer<typeof AuthVerdictSchema>;

/** A domain name, lower-cased, without a trailing dot. */
const DomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .transform((d) => d.replace(/\.$/, ""))
  .pipe(z.string().regex(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/));

const AddressSchema = z.string().trim().toLowerCase().pipe(z.email().max(INBOUND_EMAIL_LIMITS.address));

function cutTo(max: number) {
  return z.preprocess((v) => (typeof v === "string" ? v.slice(0, max) : emptyToNull(v)), z.string().nullable());
}

/**
 * One email, as an inbound provider adapter (src/lib/email/, built by
 * link-import) turns the provider's webhook body into it, after checking
 * the provider's signature. Provider-neutral: Postmark, Cloudflare Email
 * Routing (via a Worker), and others all map onto this. Attachments are
 * never included.
 *
 * Never stored. The app reads it, keeps only the extracted items, the shop
 * name and the order date (email_imports), and drops it.
 */
export const InboundEmailSchema = z.object({
  /** The provider's message ID, for spotting a redelivered webhook. Stored only as a hash. */
  messageId: z.string().min(1).max(998),
  /**
   * The sender: the address in the email's header From (what DMARC checks),
   * not the envelope sender. A bare address, lower-cased; the adapter strips
   * any display name.
   */
  from: AddressSchema,
  /** Every recipient address (To and Cc, plus the envelope recipient). One should hold a forwarding token. */
  to: z.array(AddressSchema).min(1).max(50),
  subject: scrapedText(INBOUND_EMAIL_LIMITS.subject),
  /** Plain-text body, cut to INBOUND_EMAIL_LIMITS.text. Null if the email had none. */
  text: cutTo(INBOUND_EMAIL_LIMITS.text),
  /** HTML body, cut to INBOUND_EMAIL_LIMITS.html. Null if the email had none. */
  html: cutTo(INBOUND_EMAIL_LIMITS.html),
  /** When the provider received it. */
  receivedAt: TimestampSchema,
  /**
   * The provider's checks of the forwarding hop (the user's mail server to
   * the provider), with the domains each check authenticated.
   */
  auth: z.object({
    spf: AuthVerdictSchema,
    /**
     * The domain SPF checked (the envelope sender's, MAIL FROM), or null if
     * not reported. Something that isn't a domain reads as null (fails safe).
     */
    spfDomain: z.preprocess((v) => {
      const parsed = DomainSchema.safeParse(v);
      return parsed.success ? parsed.data : null;
    }, DomainSchema.nullable()),
    dkim: AuthVerdictSchema,
    /**
     * The signing domains (d=) of the DKIM signatures that passed. Empty if
     * none passed or none were reported; entries that aren't domains are
     * dropped (fails safe).
     */
    dkimDomains: z.preprocess(
      (v) =>
        Array.isArray(v)
          ? v.flatMap((d) => {
              const parsed = DomainSchema.safeParse(d);
              return parsed.success ? [parsed.data] : [];
            }).slice(0, 20)
          : [],
      z.array(DomainSchema),
    ),
    dmarc: AuthVerdictSchema,
  }),
  /** The provider's spam verdict; null if it doesn't give one. */
  spam: z.object({ isSpam: z.boolean().nullable(), score: z.number().nullable() }),
});
export type InboundEmail = z.infer<typeof InboundEmailSchema>;

export type InboundEmailVerdict =
  | { accepted: true }
  | { accepted: false; error: Extract<EmailImportError, "sender_not_allowed" | "failed_checks"> };

/**
 * True if `authenticated` (a domain SPF or DKIM vouched for) is aligned with
 * the From domain: the same domain, or the From domain is a subdomain of it
 * (DMARC's relaxed alignment).
 */
export function isAlignedDomain(fromDomain: string, authenticated: string): boolean {
  const from = fromDomain.toLowerCase().replace(/\.$/, "");
  const auth = authenticated.toLowerCase().replace(/\.$/, "");
  return from === auth || from.endsWith(`.${auth}`);
}

/**
 * The spec's acceptance rule, in one place: an email is accepted only if
 * it was forwarded from the user's own sign-in address (the header From)
 * and passes the service's spam and authentication checks.
 *
 * Authentication:
 * - DMARC `pass` is enough (DMARC itself checks alignment with From).
 * - DMARC `none` (the From domain publishes no policy): a passing DKIM
 *   signature from an aligned domain, or a passing SPF check for an aligned
 *   domain, is needed.
 * - Anything else is refused: DMARC `fail`, `softfail`, `neutral`, and
 *   `unknown` (not reported, or an odd value such as temperror/permerror).
 *
 * Anything the service marks as spam is refused.
 */
export function judgeInboundEmail(email: InboundEmail, userEmail: string): InboundEmailVerdict {
  if (email.from !== userEmail.trim().toLowerCase()) return { accepted: false, error: "sender_not_allowed" };
  if (email.spam.isSpam === true) return { accepted: false, error: "failed_checks" };
  const { spf, spfDomain, dkim, dkimDomains, dmarc } = email.auth;
  const fromDomain = email.from.slice(email.from.lastIndexOf("@") + 1);
  const alignedDkim = dkim === "pass" && dkimDomains.some((d) => isAlignedDomain(fromDomain, d));
  const alignedSpf = spf === "pass" && spfDomain !== null && isAlignedDomain(fromDomain, spfDomain);
  const authenticated = dmarc === "pass" || (dmarc === "none" && (alignedDkim || alignedSpf));
  return authenticated ? { accepted: true } : { accepted: false, error: "failed_checks" };
}

/** Response to the inbound email service. Always this, once the signature checks out, so the service doesn't retry. */
export const InboundWebhookResponseSchema = z.object({ received: z.literal(true) });
export type InboundWebhookResponse = z.infer<typeof InboundWebhookResponseSchema>;

// ---------------------------------------------------------------------------
// Email imports (the email_imports table, and GET /api/email-imports)
// ---------------------------------------------------------------------------

/**
 * processing: the email was accepted and its items are being added.
 * done: finished; `itemCount` items were added (possibly 0, if the order
 * had no clothes or shoes), `skippedCount` weren't (see `error`).
 * failed: nothing was added; `error` says why.
 */
export const EMAIL_IMPORT_STATUSES = ["processing", "done", "failed"] as const;
export const EmailImportStatusSchema = z.enum(EMAIL_IMPORT_STATUSES);
export type EmailImportStatus = z.infer<typeof EmailImportStatusSchema>;

/**
 * Why an import failed, or why some of its items were skipped. Codes only,
 * never email content.
 */
export const EMAIL_IMPORT_ERRORS = [
  "sender_not_allowed", // not forwarded from the user's sign-in address
  "failed_checks", // failed the service's authentication or spam checks
  "no_items_found", // nothing in it looked like clothes or shoes
  "daily_cap_reached", // the daily item or email cap ran out part-way (or before it started)
  "ai_paused", // the monthly AI spend cap is reached
  "ai_failed", // the model couldn't read the email (twice)
  "internal", // anything else
] as const;
export const EmailImportErrorSchema = z.enum(EMAIL_IMPORT_ERRORS);
export type EmailImportError = z.infer<typeof EmailImportErrorSchema>;

/** One forwarded email, as the user sees it. */
export const EmailImportSchema = z.object({
  id: IdSchema,
  receivedAt: TimestampSchema,
  /** As the email named the shop, e.g. "Next". Null if it couldn't be read. */
  shopName: scrapedText(80),
  /** YYYY-MM-DD, or null. */
  orderDate: z.iso.date().nullable(),
  status: EmailImportStatusSchema,
  /** Items added to the wardrobe (marked "to review"). */
  itemCount: z.int().min(0),
  /** Clothing or shoe lines found but not added (cap reached, or adding one failed). */
  skippedCount: z.int().min(0),
  /** Required when `failed`; set when `done` with skipped lines; otherwise null. */
  error: EmailImportErrorSchema.nullable(),
}).refine((i) => i.status !== "failed" || i.error !== null, {
  path: ["error"],
  error: "A failed import needs an error code",
});
export type EmailImport = z.infer<typeof EmailImportSchema>;
