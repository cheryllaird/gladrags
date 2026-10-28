/**
 * Rate limits on the sign-in routes (POST /api/auth/magic-link and
 * /api/auth/verify-code): per email and per IP address, in a sliding
 * 15-minute window. They stop one person flooding someone's inbox,
 * guessing a 6-digit code, or probing the allowlist at volume.
 *
 * - The check runs BEFORE the allowlist check and counts every email
 *   alike, so a refusal says nothing about whether an email is invited.
 * - Keys are HMAC-SHA-256 hashes made with a server-only key
 *   (SIGN_IN_HASH_KEY), so the sign_in_attempts table is pseudonymous:
 *   without the key, its rows can't be matched to an email or IP address,
 *   not even by hashing guesses. Rows over a day old are removed by the
 *   daily cleanup.
 * - The IP is the client's, as Vercel reports it (x-real-ip, or the first
 *   x-forwarded-for entry, both set by Vercel's edge). If none is known, only
 *   the email limit applies: everyone is never pooled under one shared
 *   "unknown" key, which would let one person lock everyone out. The IP
 *   limit is higher than the email one, since a household, office or
 *   mobile network can share an address. IPv6 addresses are keyed by
 *   their /64 network, since one home or phone connection gets a whole
 *   /64 and could otherwise rotate through 2^64 addresses.
 */
import "server-only";
import { createHmac } from "node:crypto";
import { isIPv4, isIPv6 } from "node:net";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { ApiException } from "@/lib/api/errors";
import { ConfigError, isMockMode } from "@/lib/env";
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

/** Used only in mock mode and tests, where there's nothing real to protect. */
const DEV_HASH_KEY = "gladrags-dev-only-sign-in-hash-key-not-for-production";

/** The shortest SIGN_IN_HASH_KEY accepted (32 characters, e.g. `openssl rand -hex 32` gives 64). */
export const MIN_SIGN_IN_HASH_KEY_LENGTH = 32;

/**
 * The HMAC key for sign-in attempt keys. Outside mock mode and tests it
 * must be set (SIGN_IN_HASH_KEY), or sign-in fails closed with
 * server_misconfigured rather than storing guessable hashes.
 */
export function signInHashKey(): string {
  const key = process.env.SIGN_IN_HASH_KEY;
  if (key && key.trim() === key && key.length >= MIN_SIGN_IN_HASH_KEY_LENGTH) return key;
  if (!key && (isMockMode() || process.env.NODE_ENV === "test")) return DEV_HASH_KEY;
  throw new ConfigError(
    `SIGN_IN_HASH_KEY must be set to at least ${MIN_SIGN_IN_HASH_KEY_LENGTH} characters, with no spaces around it. See .env.example.`,
  );
}

function hmac(text: string): string {
  return createHmac("sha256", signInHashKey()).update(text).digest("hex");
}

export const hashEmail = (email: string) => hmac(`gladrags:email:${email.trim().toLowerCase()}`);
export const hashIp = (ip: string) => hmac(`gladrags:ip:${ipRateLimitKey(ip)}`);

/**
 * What an IP address is limited by: an IPv4 address as it is (IPv4-mapped
 * IPv6 such as ::ffff:203.0.113.7 counts as IPv4), an IPv6 address by its
 * /64 network, e.g. "2001:db8:1:2::/64". Anything else is used as given.
 */
export function ipRateLimitKey(ip: string): string {
  const address = ip.trim().replace(/^\[|\]$/g, "");
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped && isIPv4(mapped[1]!)) return mapped[1]!;
  if (isIPv4(address) || !isIPv6(address)) return address;
  return `${expandIpv6(address).slice(0, 4).join(":")}::/64`;
}

/** The eight hextets of an IPv6 address, lower-case without leading zeros. */
function expandIpv6(address: string): string[] {
  let text = address.toLowerCase().split("%")[0]!;
  // An embedded IPv4 tail (e.g. 64:ff9b::192.0.2.1) becomes two hextets.
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.includes("::") ? text.split("::") : [text, null];
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const zeros = tail === null ? [] : Array(8 - left.length - right.length).fill("0");
  return [...left, ...zeros, ...right].map((part) => parseInt(part || "0", 16).toString(16));
}

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
