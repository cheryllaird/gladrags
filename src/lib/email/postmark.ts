/**
 * Postmark inbound (INBOUND_EMAIL_PROVIDER=postmark): Postmark receives
 * mail for the forwarding addresses and POSTs each email to
 * /api/inbound/email as JSON.
 *
 * Authentication. Postmark signs nothing: its documented way to protect an
 * inbound webhook is HTTP Basic auth credentials in the webhook URL, which
 * it sends as an `Authorization: Basic ...` header. So the webhook URL set
 * in Postmark is
 *
 *   https://postmark:<INBOUND_EMAIL_WEBHOOK_SECRET>@<site>/api/inbound/email
 *
 * and `verify` compares the password (in constant time) with the secret.
 * The user name isn't checked. There's no timestamp, so a captured request
 * could be replayed: the request only travels over HTTPS, and a replay is
 * ignored anyway because the message ID was already seen (email_imports).
 *
 * Mapping (Postmark's inbound JSON):
 * - from: FromFull.Email, the header From (what DMARC checks).
 * - to: ToFull, CcFull and BccFull addresses, plus OriginalRecipient (the
 *   envelope recipient).
 * - messageId: Postmark's MessageID, which stays the same when Postmark
 *   retries the webhook.
 * - receivedAt: when this request arrived. Postmark gives only the
 *   sender's Date header, which the sender chooses.
 * - auth: read only from Postmark's own headers, the block above the
 *   second `Received` (its SMTP receipt); everything below came with the
 *   message. Postmark checks SPF and adds `Received-SPF` there. It doesn't report DKIM or DMARC. If the app is told to trust
 *   an Authentication-Results authserv-id (INBOUND_EMAIL_AUTHSERV_ID), a
 *   header from it supplies SPF, DKIM and DMARC instead.
 *   With no DMARC result reported, `dmarc` is "none": judgeInboundEmail
 *   then accepts the email only if SPF (or DKIM) passed for a domain
 *   aligned with the From address, which is exactly the condition under
 *   which a DMARC check would pass. So this never accepts anything a real
 *   DMARC check would refuse.
 * - spam: SpamAssassin's X-Spam-Status and X-Spam-Score from that block.
 * - Attachments are ignored (Postmark should also be set to drop them).
 */
import "server-only";
import { z } from "zod";
import {
  domainOf,
  firstHeader,
  parseReceivedSpf,
  parseSpamHeaders,
  serviceHeaderBlock,
  trustedAuthenticationResults,
  type EmailHeader,
} from "./auth-headers";
import type { InboundEmailProvider, InboundWebhookRequest } from "./types";
import { secretsEqual } from "./webhook-request";

const AddressEntrySchema = z.object({ Email: z.string() }).loose();
const AddressListSchema = z.array(AddressEntrySchema).catch([]);

/** The parts of Postmark's inbound JSON the app uses. Everything else (Attachments included) is ignored. */
const PostmarkInboundSchema = z
  .object({
    MessageID: z.string().min(1),
    FromFull: AddressEntrySchema,
    ToFull: AddressListSchema.optional(),
    CcFull: AddressListSchema.optional(),
    BccFull: AddressListSchema.optional(),
    OriginalRecipient: z.string().optional().catch(undefined),
    Subject: z.string().nullish().catch(null),
    TextBody: z.string().nullish().catch(null),
    HtmlBody: z.string().nullish().catch(null),
    Headers: z
      .array(z.object({ Name: z.string(), Value: z.string() }).loose())
      .catch([])
      .optional(),
  })
  .loose();

/** A plausible bare address; anything else in a recipient list is dropped rather than failing the email. */
const LooseAddressSchema = z.string().trim().toLowerCase().pipe(z.email().max(320));

export interface PostmarkOptions {
  /** INBOUND_EMAIL_WEBHOOK_SECRET: the password in the webhook URL. */
  secret: string;
  /** Authentication-Results authserv-ids to trust (INBOUND_EMAIL_AUTHSERV_ID). Usually none for Postmark. */
  trustedAuthservIds?: readonly string[];
  now?: () => Date;
}

/** The password from an `Authorization: Basic ...` header, or null. */
export function basicAuthPassword(header: string | null): string | null {
  if (!header) return null;
  const match = /^\s*basic\s+([a-z0-9+/=_-]+)\s*$/i.exec(header);
  if (!match) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(match[1]!, "base64").toString("utf8");
  } catch {
    return null;
  }
  const colon = decoded.indexOf(":");
  return colon < 0 ? null : decoded.slice(colon + 1);
}

export class PostmarkInboundProvider implements InboundEmailProvider {
  readonly name = "postmark";
  private readonly now: () => Date;

  constructor(private readonly options: PostmarkOptions) {
    this.now = options.now ?? (() => new Date());
  }

  verify(request: InboundWebhookRequest): boolean {
    const password = basicAuthPassword(request.headers.get("authorization"));
    // Compare even when there's no password, so a missing header takes as long as a wrong one.
    const ok = secretsEqual(password ?? "", this.options.secret);
    return ok && password !== null;
  }

  parse(rawBody: Uint8Array): unknown {
    const json: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: false }).decode(rawBody));
    const body = PostmarkInboundSchema.parse(json);
    const headers: EmailHeader[] = (body.Headers ?? []).map((h) => ({ name: h.Name, value: h.Value }));

    const recipients = [
      ...(body.ToFull ?? []),
      ...(body.CcFull ?? []),
      ...(body.BccFull ?? []),
      ...(body.OriginalRecipient ? [{ Email: body.OriginalRecipient }] : []),
    ].flatMap((entry) => {
      const parsed = LooseAddressSchema.safeParse(entry.Email);
      return parsed.success ? [parsed.data] : [];
    });

    // Only Postmark's own headers count: those above the second Received
    // (see serviceHeaderBlock). Anything lower came with the message.
    const own = serviceHeaderBlock(headers);
    const trusted = trustedAuthenticationResults(own, this.options.trustedAuthservIds ?? []);
    const receivedSpf = parseReceivedSpf(firstHeader(own, "Received-SPF"));
    const spf = trusted?.spf ?? receivedSpf.result;
    const spfDomain = agreesWithReturnPath(trusted?.spf ? trusted.spfDomain : receivedSpf.domain, own);

    return {
      messageId: body.MessageID,
      from: body.FromFull.Email,
      to: [...new Set(recipients)].slice(0, 50),
      subject: body.Subject ?? null,
      text: body.TextBody ?? null,
      html: body.HtmlBody ?? null,
      receivedAt: this.now().toISOString(),
      auth: {
        spf: spf ?? "unknown",
        spfDomain: spfDomain ?? null,
        dkim: trusted?.dkim ?? "none",
        dkimDomains: trusted?.dkimDomains ?? [],
        // See the header comment: no reported DMARC check reads as "none".
        dmarc: trusted?.dmarc ?? "none",
      },
      spam: parseSpamHeaders(own),
    };
  }
}

/**
 * A second check on the SPF domain, failing closed: Postmark records the
 * envelope sender as Return-Path in its own block, and the SPF domain is
 * trusted only if that Return-Path is there, has no quotes (quoted local
 * parts are refused outright), and names the same domain. Otherwise null,
 * which refuses alignment.
 */
function agreesWithReturnPath(spfDomain: string | null, own: readonly EmailHeader[]): string | null {
  const returnPath = firstHeader(own, "Return-Path");
  if (spfDomain === null || returnPath === undefined || returnPath.includes('"')) return null;
  return domainOf(returnPath) === spfDomain ? spfDomain : null;
}

/** For tests and docs: the Authorization header Postmark sends for a webhook URL with these credentials. */
export function basicAuthHeader(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`, "utf8").toString("base64")}`;
}
