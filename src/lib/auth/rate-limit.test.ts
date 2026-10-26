import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { ApiException } from "@/lib/api/errors";
import {
  InMemorySignInAttemptStore,
  SIGN_IN_LIMITS,
  SupabaseSignInAttemptStore,
  assertSignInAttemptAllowed,
  clientIp,
  hashEmail,
  hashIp,
} from "./rate-limit";

const LIMITS = { perEmail: 2, perIp: 3, windowSeconds: 900 };

function request(headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/auth/magic-link", { method: "POST", headers });
}

function setup() {
  let now = new Date("2026-10-26T10:00:00Z");
  const clock = () => now;
  const store = new InMemorySignInAttemptStore(clock);
  const attempt = (email: string, headers: Record<string, string> = {}, action: "magic_link" | "verify_code" = "magic_link") =>
    assertSignInAttemptAllowed(store, action, email, request(headers), LIMITS, clock);
  return { store, attempt, advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
}

async function refusal(promise: Promise<void>): Promise<ApiException | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    if (error instanceof ApiException) return error;
    throw error;
  }
}

describe("sign-in limits", () => {
  it("are 5 per email and 20 per IP per 15 minutes", () => {
    expect(SIGN_IN_LIMITS).toEqual({ perEmail: 5, perIp: 20, windowSeconds: 900 });
  });

  it("refuse an email over its limit with 429 rate_limited and a wait time, without saying why", async () => {
    const { attempt } = setup();
    await attempt("a@example.com");
    await attempt("A@Example.com "); // the same email, normalised
    const error = await refusal(attempt("a@example.com"));
    expect(error?.code).toBe("rate_limited");
    expect(error?.message).toBe("Too many sign-in attempts. Wait 15 minutes and try again.");
    expect(error?.message).not.toMatch(/invite|list/i);
  });

  it("refuse an IP over its limit across different emails, with the same message", async () => {
    const { attempt } = setup();
    const ip = { "x-forwarded-for": "203.0.113.7, 10.0.0.1" };
    for (const email of ["a@example.com", "b@example.com", "c@example.com"]) await attempt(email, ip);
    const error = await refusal(attempt("d@example.com", ip));
    expect(error?.code).toBe("rate_limited");
    expect(error?.message).toMatch(/^Too many sign-in attempts/);
    // Someone on another address isn't affected.
    expect(await refusal(attempt("d@example.com", { "x-forwarded-for": "198.51.100.2" }))).toBeNull();
  });

  it("never pools requests with no known IP: only the email limit applies", async () => {
    const { attempt } = setup();
    for (let i = 0; i < 10; i++) expect(await refusal(attempt(`user${i}@example.com`))).toBeNull();
  });

  it("count magic links and code checks separately", async () => {
    const { attempt } = setup();
    await attempt("a@example.com");
    await attempt("a@example.com");
    expect(await refusal(attempt("a@example.com", {}, "verify_code"))).toBeNull();
  });

  it("slide: attempts older than the window stop counting, and the wait shown shrinks", async () => {
    const { attempt, advance } = setup();
    await attempt("a@example.com");
    advance(10 * 60_000);
    await attempt("a@example.com");
    expect((await refusal(attempt("a@example.com")))?.message).toContain("Wait 5 minutes");
    advance(5 * 60_000 + 1);
    expect(await refusal(attempt("a@example.com"))).toBeNull();
  });

  it("parallel attempts can't overshoot", async () => {
    const { attempt, store } = setup();
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => attempt("a@example.com")));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect(store.attempts).toHaveLength(2);
  });

  it("store hashes only, never the email or IP", async () => {
    const { attempt, store } = setup();
    await attempt("secret.person@example.com", { "x-real-ip": "203.0.113.9" });
    const stored = JSON.stringify(store.attempts);
    expect(stored).not.toContain("secret.person");
    expect(stored).not.toContain("203.0.113.9");
    expect(store.attempts.map((a) => a.hash)).toEqual([hashEmail("secret.person@example.com"), hashIp("203.0.113.9")]);
    expect(hashEmail("x@example.com")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("clientIp", () => {
  it("prefers x-real-ip, then the first x-forwarded-for entry, else null", () => {
    expect(clientIp(request({ "x-real-ip": "203.0.113.1", "x-forwarded-for": "198.51.100.1" }))).toBe("203.0.113.1");
    expect(clientIp(request({ "x-forwarded-for": " 198.51.100.1 , 10.0.0.2" }))).toBe("198.51.100.1");
    expect(clientIp(request({ "x-forwarded-for": "" }))).toBeNull();
    expect(clientIp(request())).toBeNull();
  });
});

describe("SupabaseSignInAttemptStore", () => {
  function client(reply: { data: unknown; error: { message: string } | null }) {
    const calls: unknown[] = [];
    return {
      calls,
      admin: { rpc: async (fn: string, args: unknown) => (calls.push({ fn, args }), reply) } as unknown as SupabaseClient,
    };
  }

  it("calls reserve_sign_in_attempt with the hashes and limits", async () => {
    const { admin, calls } = client({ data: { ok: true, denied: null, retry_at: null }, error: null });
    expect(await new SupabaseSignInAttemptStore(admin).reserve("verify_code", "e".repeat(64), null, LIMITS)).toEqual({ ok: true });
    expect(calls).toEqual([
      {
        fn: "reserve_sign_in_attempt",
        args: { p_action: "verify_code", p_email_hash: "e".repeat(64), p_ip_hash: null, p_email_limit: 2, p_ip_limit: 3, p_window_seconds: 900 },
      },
    ]);
  });

  it("reads a refusal's retry time", async () => {
    const { admin } = client({ data: { ok: false, denied: "ip", retry_at: "2026-10-26T10:15:00+00:00" }, error: null });
    expect(await new SupabaseSignInAttemptStore(admin).reserve("magic_link", "e".repeat(64), "i".repeat(64), LIMITS)).toEqual({
      ok: false,
      retryAt: new Date("2026-10-26T10:15:00Z"),
    });
  });

  it.each([[null], [{ ok: false }], [{ ok: false, retry_at: "soon" }], ["yes"]])("throws on a malformed reply %j instead of letting it through", async (data) => {
    const { admin } = client({ data, error: null });
    await expect(new SupabaseSignInAttemptStore(admin).reserve("magic_link", "e".repeat(64), null, LIMITS)).rejects.toThrow();
  });
});
