/**
 * POST /api/inbound/email after the signature checked out and the email
 * was normalised (CONTRACTS.md section 5, "Order emails", steps 2 to 5).
 * Everything here is quick: the slow part (the model reading the email,
 * then fetching, storing and tagging each item) is returned as a job for
 * the route to run after it has answered the email service.
 *
 * 2. Find the user from the token in a recipient address. Unknown token:
 *    nothing is recorded, so the address can't be probed.
 * 3. Record the email as `processing`, keyed by a hash of its message ID:
 *    a redelivery (same user and hash) stops here.
 * 4. judgeInboundEmail: refused emails are recorded as `failed` with the
 *    reason, and nothing of their content is kept.
 * 5. Count one forwarded email against `emails_per_day`. A cap reached is
 *    recorded as `failed` too.
 */
import "server-only";
import { createHash } from "node:crypto";
import { judgeInboundEmail, tokenFromAddress, type ForwardingAddressConfig, type InboundEmail } from "@/contracts";
import { CapReachedError } from "@/lib/usage/errors";
import type { UsageGuard, UsageReservation } from "@/lib/usage/guard";
import type { EmailImportRepository, ForwardingUser } from "./repository";

export interface ReceiveDeps {
  imports: EmailImportRepository;
  usage: UsageGuard;
}

/** An accepted email, ready to process. Held in memory only, never stored. */
export interface AcceptedEmail {
  importId: string;
  user: ForwardingUser;
  email: InboundEmail;
  /** The `emails_per_day` count, given back if AI pauses before the model reads it. */
  counted: UsageReservation;
}

/** SHA-256 (hex) of the provider's message ID: all email_imports keeps of it. */
export function messageHash(messageId: string): string {
  return createHash("sha256").update(messageId, "utf8").digest("hex");
}

/**
 * Null when there's nothing more to do (unknown token, redelivery,
 * refused, or over the daily email cap); otherwise the accepted email.
 * Throws only for errors on our side (the webhook then answers 5xx and the
 * service retries).
 */
export async function receiveInboundEmail(
  deps: ReceiveDeps,
  email: InboundEmail,
  config: ForwardingAddressConfig | null,
): Promise<AcceptedEmail | null> {
  if (!config) return null;
  const token = email.to.map((address) => tokenFromAddress(address, config)).find((t) => t !== null);
  if (!token) return null;
  const user = await deps.imports.findUserByToken(token);
  if (!user) return null;

  const importId = await deps.imports.start(user.userId, messageHash(email.messageId), email.receivedAt);
  if (!importId) return null;

  try {
    return await judgeAndCount(deps, importId, user, email);
  } catch (error) {
    // Our side failed (database or usage store). Take the row back out so
    // the service's retry isn't mistaken for a redelivery, then let the
    // webhook answer 5xx.
    await deps.imports.abandon(importId).catch(() => {});
    throw error;
  }
}

async function judgeAndCount(deps: ReceiveDeps, importId: string, user: ForwardingUser, email: InboundEmail): Promise<AcceptedEmail | null> {
  const failed = (error: "sender_not_allowed" | "failed_checks" | "daily_cap_reached" | "ai_paused") =>
    deps.imports.finish(importId, { status: "failed", shopName: null, orderDate: null, itemCount: 0, skippedCount: 0, error });

  const verdict = judgeInboundEmail(email, user.email);
  if (!verdict.accepted) {
    await failed(verdict.error);
    return null;
  }

  let counted: UsageReservation;
  try {
    counted = await deps.usage.reserveAction(user.userId, "email_import");
  } catch (error) {
    if (!(error instanceof CapReachedError)) throw error;
    await failed(error.cap === "monthly_ai_spend" ? "ai_paused" : "daily_cap_reached");
    return null;
  }
  return { importId, user, email, counted };
}
