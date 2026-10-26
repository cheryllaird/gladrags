/**
 * Rate limits on the sign-in routes (POST /api/auth/magic-link and
 * /api/auth/verify-code): per email and per IP address, in a sliding
 * 15-minute window. They stop one person flooding someone's inbox,
 * guessing a 6-digit code, or probing the allowlist at volume.
 *
 * - The check runs BEFORE the allowlist check and counts every email
 *   alike, so a refusal says nothing about whether an email is invited.
 * - Keys are SHA-256 hashes, so the sign_in_attempts table holds no email
 *   or IP addresses. Rows over a day old are removed by the daily cleanup.
 * - The IP is the client's, as Vercel reports it (x-real-ip, or the first
 *   x-forwarded-for entry, both set by Vercel's edge). If none is known, only
 *   the email limit applies: everyone is never pooled under one shared
 *   "unknown" key, which would let one person lock everyone out. The IP
 *   limit is higher than the email one, since a household, office or
 *   mobile network can share an address.
 */
import "server-only";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { ApiException } from "@/lib/api/errors";
import { isMockMode } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";

export type SignInAction = "magic_link" | "verify_code";

export interface SignInLimits {
  perEmail: number;
  perIp: number;
  windowSeconds: number;
}

/** 5 per email and 20 per IP address, per 15 minutes, for each route. */
export const SIGN_IN_LIMITS: SignInLimits = { perEmail: 5, perIp: 20, windowSeconds: 15 * 60 };

/** How long sign-in attempt rows are kept (the cleanup job deletes older ones). */
export const SIGN_IN_ATTEMPT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type SignInAttemptResult = { ok: true } | { ok: false; retryAt: Date };

export interface SignInAttemptStore {
  /** Record one attempt, or refuse it if either key reached its limit. Atomic. */
  reserve(action: SignInAction, emailHash: string, ipHash: string | null, limits: SignInLimits): Promise<SignInAttemptResult>;
  /** Delete attempts created before the cutoff. Returns how many went. */
  deleteCreatedBefore(cutoff: Date): Promise<number>;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export const hashEmail = (email: string) => sha256(`gladrags:email:${email.trim().toLowerCase()}`);
export const hashIp = (ip: string) => sha256(`gladrags:ip:${ip}`);

/** The client's IP address as the hosting platform reports it, or null. */
export function clientIp(request: Request): string | null {
  const real = request.headers.get("x-real-ip")?.trim();
  if (real) return real;
  const first = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return first || null;
}

/**
 * Throws a 429 rate_limited ApiException if this email or IP has made too
 * many attempts at this action recently. The message is the same either
 * way and doesn't mention the allowlist.
 */
export async function assertSignInAttemptAllowed(
  store: SignInAttemptStore,
  action: SignInAction,
  email: string,
  request: Request,
  limits: SignInLimits = SIGN_IN_LIMITS,
  now: () => Date = () => new Date(),
): Promise<void> {
  const ip = clientIp(request);
  const result = await store.reserve(action, hashEmail(email), ip ? hashIp(ip) : null, limits);
  if (result.ok) return;
  const minutes = Math.max(1, Math.ceil((result.retryAt.getTime() - now().getTime()) / 60_000));
  throw new ApiException(
    "rate_limited",
    `Too many sign-in attempts. Wait ${minutes} minute${minutes === 1 ? "" : "s"} and try again.`,
  );
}

// ---------------------------------------------------------------------------
// Stores
// ---------------------------------------------------------------------------

const ReserveSignInResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), retry_at: z.string() }),
]);

/** Backed by public.sign_in_attempts and reserve_sign_in_attempt(). Needs the admin client. */
export class SupabaseSignInAttemptStore implements SignInAttemptStore {
  constructor(private readonly admin: SupabaseClient) {}

  async reserve(action: SignInAction, emailHash: string, ipHash: string | null, limits: SignInLimits): Promise<SignInAttemptResult> {
    const { data, error } = await this.admin.rpc("reserve_sign_in_attempt", {
      p_action: action,
      p_email_hash: emailHash,
      p_ip_hash: ipHash,
      p_email_limit: limits.perEmail,
      p_ip_limit: limits.perIp,
      p_window_seconds: limits.windowSeconds,
    });
    if (error) throw new Error(`Couldn't check sign-in attempts: ${error.message}`);
    const result = ReserveSignInResultSchema.parse(data);
    if (result.ok) return { ok: true };
    const retryAt = new Date(result.retry_at);
    if (Number.isNaN(retryAt.getTime())) throw new Error("Couldn't check sign-in attempts: bad retry time");
    return { ok: false, retryAt };
  }

  async deleteCreatedBefore(cutoff: Date): Promise<number> {
    const { data, error } = await this.admin.from("sign_in_attempts").delete().lt("created_at", cutoff.toISOString()).select("id");
    if (error) throw new Error(`Couldn't delete old sign-in attempts: ${error.message}`);
    return (data ?? []).length;
  }
}

/** For tests and mock mode. Atomic: no await between the check and the push. */
export class InMemorySignInAttemptStore implements SignInAttemptStore {
  readonly attempts: { action: SignInAction; kind: "email" | "ip"; hash: string; at: Date }[] = [];

  constructor(private readonly now: () => Date = () => new Date()) {}

  async reserve(action: SignInAction, emailHash: string, ipHash: string | null, limits: SignInLimits): Promise<SignInAttemptResult> {
    const since = this.now().getTime() - limits.windowSeconds * 1000;
    const recent = (kind: "email" | "ip", hash: string) =>
      this.attempts.filter((a) => a.action === action && a.kind === kind && a.hash === hash && a.at.getTime() >= since);
    const retryAt = (rows: { at: Date }[]) => new Date(Math.min(...rows.map((r) => r.at.getTime())) + limits.windowSeconds * 1000);

    const byEmail = recent("email", emailHash);
    if (byEmail.length >= limits.perEmail) return { ok: false, retryAt: retryAt(byEmail) };
    if (ipHash) {
      const byIp = recent("ip", ipHash);
      if (byIp.length >= limits.perIp) return { ok: false, retryAt: retryAt(byIp) };
    }
    const at = this.now();
    this.attempts.push({ action, kind: "email", hash: emailHash, at });
    if (ipHash) this.attempts.push({ action, kind: "ip", hash: ipHash, at });
    return { ok: true };
  }

  async deleteCreatedBefore(cutoff: Date): Promise<number> {
    const before = this.attempts.length;
    const kept = this.attempts.filter((a) => a.at >= cutoff);
    this.attempts.splice(0, this.attempts.length, ...kept);
    return before - kept.length;
  }
}

const globalForSignIn = globalThis as unknown as { __gladragsMockSignInAttempts?: InMemorySignInAttemptStore };

/** In memory in mock mode (fresh per request in end-to-end runs, like the usage caps); Supabase otherwise. */
export function getSignInAttemptStore(): SignInAttemptStore {
  if (isMockMode()) {
    if (process.env.GLADRAGS_E2E === "true") return new InMemorySignInAttemptStore();
    globalForSignIn.__gladragsMockSignInAttempts ??= new InMemorySignInAttemptStore();
    return globalForSignIn.__gladragsMockSignInAttempts;
  }
  return new SupabaseSignInAttemptStore(createAdminClient());
}
