/**
 * QA (fix/hardening): the session cookies the REAL @supabase/ssr client
 * writes (not just the options we pass it), with Supabase's auth server
 * replaced by a stubbed fetch. Sign-in by code, the proxy's token refresh,
 * and sign-out all set httpOnly, SameSite=Lax cookies, Secure in production.
 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const jar = vi.hoisted(() => ({
  incoming: [] as { name: string; value: string }[],
  sets: [] as { name: string; value: string; options: Record<string, unknown> }[],
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    getAll: () => jar.incoming,
    set: (name: string, value: string, options: Record<string, unknown>) => jar.sets.push({ name, value, options }),
  }),
}));

import { updateSession } from "./proxy";
import { createClient } from "./server";

const PROJECT = "https://qaproject.supabase.co";
const COOKIE = "sb-qaproject-auth-token";
const USER = { id: "0c000000-0000-4000-8000-000000000003", aud: "authenticated", role: "authenticated", email: "tester@example.com", app_metadata: {}, user_metadata: {}, created_at: "2026-10-01T00:00:00Z" };

function b64url(text: string) {
  return Buffer.from(text).toString("base64url");
}
function jwt(expSeconds: number) {
  return `${b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64url(JSON.stringify({ sub: USER.id, exp: expSeconds, aud: "authenticated", role: "authenticated", email: USER.email }))}.sig`;
}
function session(expiresInSeconds: number) {
  const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
  return { access_token: jwt(exp), refresh_token: "refresh-qa", token_type: "bearer", expires_in: expiresInSeconds, expires_at: exp, user: USER };
}

const calls: string[] = [];

beforeEach(() => {
  jar.incoming = [];
  jar.sets = [];
  calls.length = 0;
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", PROJECT);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_qa");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      calls.push(`${url.pathname}${url.search}`);
      if (url.pathname === "/auth/v1/verify") return Response.json(session(3600));
      if (url.pathname === "/auth/v1/token") return Response.json(session(3600));
      if (url.pathname === "/auth/v1/user") return Response.json(USER);
      if (url.pathname === "/auth/v1/logout") return new Response(null, { status: 204 });
      return new Response("not found", { status: 404 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function expectSessionCookieOptions(options: Record<string, unknown>, secure: boolean) {
  expect(options.httpOnly).toBe(true);
  expect(options.sameSite).toBe("lax");
  expect(options.secure).toBe(secure);
  expect(options.path).toBe("/");
}

describe("cookies written by the real Supabase SSR client", () => {
  it("signing in with a code (verifyOtp) sets httpOnly, Lax, Secure session cookies in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const supabase = await createClient();
    const { error } = await supabase.auth.verifyOtp({ email: USER.email, token: "123456", type: "email" });
    expect(error).toBeNull();
    const written = jar.sets.filter((c) => c.name.startsWith(COOKIE) && c.value !== "");
    expect(written.length).toBeGreaterThan(0);
    for (const cookie of written) expectSessionCookieOptions(cookie.options, true);
  });

  it("outside production the cookies are still httpOnly and Lax, just not Secure (localhost over http)", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const supabase = await createClient();
    await supabase.auth.verifyOtp({ email: USER.email, token: "123456", type: "email" });
    const written = jar.sets.filter((c) => c.name.startsWith(COOKIE) && c.value !== "");
    for (const cookie of written) expectSessionCookieOptions(cookie.options, false);
  });

  it("the proxy's token refresh writes Set-Cookie headers with HttpOnly; Secure; SameSite=lax", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const expired = session(-60);
    const request = new NextRequest("https://gladrags.example/wardrobe", {
      headers: { cookie: `${COOKIE}=base64-${b64url(JSON.stringify(expired))}` },
    });
    const { response, user } = await updateSession(request);
    expect(calls.some((c) => c.startsWith("/auth/v1/token"))).toBe(true);
    expect(user?.id).toBe(USER.id);
    const setCookies = response.headers.getSetCookie().filter((c) => c.startsWith(COOKIE));
    expect(setCookies.length).toBeGreaterThan(0);
    for (const header of setCookies) {
      expect(header).toMatch(/;\s*HttpOnly/i);
      expect(header).toMatch(/;\s*Secure/i);
      expect(header).toMatch(/;\s*SameSite=lax/i);
      expect(header).toMatch(/;\s*Path=\//i);
    }
  });

  it("sign-out clears the session cookie with the same attributes (so the httpOnly cookie really goes)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    jar.incoming = [{ name: COOKIE, value: `base64-${b64url(JSON.stringify(session(3600)))}` }];
    const supabase = await createClient();
    const { error } = await supabase.auth.signOut();
    expect(error).toBeNull();
    expect(calls.some((c) => c.startsWith("/auth/v1/logout"))).toBe(true);
    const cleared = jar.sets.filter((c) => c.name === COOKIE);
    expect(cleared.length).toBeGreaterThan(0);
    for (const cookie of cleared) {
      expect(cookie.value).toBe("");
      expect(cookie.options.maxAge).toBe(0);
      expectSessionCookieOptions(cookie.options, true);
    }
  });

  it("sign-out after the account was deleted (logout answers 404) still clears the cookie", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ code: 404, error_code: "user_not_found", msg: "User not found" }, { status: 404 })),
    );
    jar.incoming = [{ name: COOKIE, value: `base64-${b64url(JSON.stringify(session(3600)))}` }];
    const supabase = await createClient();
    await supabase.auth.signOut();
    const cleared = jar.sets.filter((c) => c.name === COOKIE);
    expect(cleared.length).toBeGreaterThan(0);
    expect(cleared.every((c) => c.value === "" && c.options.maxAge === 0)).toBe(true);
  });
});
