/**
 * QA (fix/hardening): /auth/confirm. A GET never signs in, whoever sends
 * it; a POST is only accepted from this site; and `next` can never send
 * the browser to another site, on either method.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ verifyOtp: vi.fn(async (_args: unknown) => ({ error: null as { message: string } | null })) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ auth: { verifyOtp: fake.verifyOtp } }) }));

import { GET, POST } from "./route";

const BASE = "http://localhost:3000";
const TOKEN = "pkce_0123456789abcdef0123456789abcdef";

function post(fields: Record<string, string>, headers: Record<string, string> = { origin: BASE }, contentType = "application/x-www-form-urlencoded") {
  return POST(
    new Request(`${BASE}/auth/confirm`, {
      method: "POST",
      headers: { "content-type": contentType, ...headers },
      body: new URLSearchParams(fields),
    }),
  );
}

function get(query: string, headers: Record<string, string> = {}) {
  return GET(new Request(`${BASE}/auth/confirm?${query}`, { headers }));
}

beforeEach(() => {
  fake.verifyOtp.mockClear();
  fake.verifyOtp.mockResolvedValue({ error: null });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("GET never signs in", () => {
  it.each([
    ["no headers (a mail scanner)", {}],
    ["from another site (an <img> or prefetch)", { origin: "https://evil.example", "sec-fetch-site": "cross-site" }],
    ["a link preview bot", { "user-agent": "Slackbot-LinkExpanding 1.0" }],
  ])("%s: shows the page, verifyOtp not called", async (_label, headers) => {
    const res = await get(`token_hash=${TOKEN}&type=email&next=%2Fwardrobe`, headers);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(fake.verifyOtp).not.toHaveBeenCalled();
  });

  it("the page's form posts to this site's path, not to an absolute URL", async () => {
    const html = await (await get(`token_hash=${TOKEN}&type=email`)).text();
    expect(html).toContain('<form method="post" action="/auth/confirm">');
    expect(html).not.toMatch(/<script/i);
  });
});

describe("POST is only accepted from this site", () => {
  it.each([
    ["a foreign Origin", { origin: "https://evil.example" }],
    ['Origin "null"', { origin: "null" }],
    ["no Origin, Sec-Fetch-Site cross-site", { "sec-fetch-site": "cross-site" }],
    ["another port", { origin: "http://localhost:4000" }],
    ["https instead of http", { origin: "https://localhost:3000" }],
  ])("%s: 403, verifyOtp not called, no redirect", async (_label, headers) => {
    const res = await post({ token_hash: TOKEN, type: "email", next: "/wardrobe" }, headers);
    expect(res.status).toBe(403);
    expect(res.headers.get("location")).toBeNull();
    expect(fake.verifyOtp).not.toHaveBeenCalled();
  });

  it("from this site: verifies the token once and redirects with 303", async () => {
    const res = await post({ token_hash: TOKEN, type: "email", next: "/wardrobe" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${BASE}/wardrobe`);
    expect(fake.verifyOtp).toHaveBeenCalledTimes(1);
    expect(fake.verifyOtp).toHaveBeenCalledWith({ token_hash: TOKEN, type: "email" });
  });

  it("a JSON body instead of the form: back to sign-in, no verify, no 500", async () => {
    const res = await POST(
      new Request(`${BASE}/auth/confirm`, { method: "POST", headers: { origin: BASE, "content-type": "application/json" }, body: JSON.stringify({ token_hash: TOKEN, type: "email" }) }),
    );
    expect(res.status).toBe(303);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/sign-in");
    expect(fake.verifyOtp).not.toHaveBeenCalled();
  });

  it("a token hash with odd characters isn't passed to Supabase", async () => {
    const res = await post({ token_hash: "abc'; drop table--", type: "email" });
    expect(new URL(res.headers.get("location")!).pathname).toBe("/sign-in");
    expect(fake.verifyOtp).not.toHaveBeenCalled();
  });
});

describe("`next` can't redirect off the site", () => {
  const ATTACKS = [
    "//evil.example",
    "//evil.example/wardrobe",
    "/\\evil.example",
    "\\\\evil.example",
    "https://evil.example",
    "http:evil.example",
    "javascript:alert(1)",
    "/\t/evil.example",
    "/ /evil.example",
    "/%0a/evil.example",
    "%2F%2Fevil.example",
    "/%2F%2Fevil.example",
    "/%5Cevil.example",
    "/.//evil.example",
    "///evil.example",
    "/wardrobe@evil.example",
    "evil.example",
    "",
  ];

  for (const next of ATTACKS) {
    it(`POST next=${JSON.stringify(next)}: the Location stays on ${BASE}`, async () => {
      const ok = await post({ token_hash: TOKEN, type: "email", next });
      const failed = (fake.verifyOtp.mockResolvedValueOnce({ error: { message: "expired" } }), await post({ token_hash: TOKEN, type: "email", next }));
      for (const res of [ok, failed]) {
        const location = new URL(res.headers.get("location")!, BASE);
        expect(location.origin).toBe(BASE);
      }
    });

    it(`GET next=${JSON.stringify(next)}: the page's hidden next is a same-site path (or "/")`, async () => {
      const res = await get(`token_hash=${TOKEN}&type=email&next=${encodeURIComponent(next)}`);
      const html = await res.text();
      const hidden = /name="next" value="([^"]*)"/.exec(html)![1]!;
      const decoded = hidden.replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">");
      expect(new URL(decoded, BASE).origin).toBe(BASE);
      expect(decoded.startsWith("/")).toBe(true);
      expect(decoded.startsWith("//")).toBe(false);
    });
  }

  it("GET without a token: the sign-in redirect keeps a safe next and drops an unsafe one", async () => {
    const safe = await get("next=%2Foutfits");
    expect(new URL(safe.headers.get("location")!).searchParams.get("next")).toBe("/outfits");
    const unsafe = await get("next=%2F%2Fevil.example");
    const location = new URL(unsafe.headers.get("location")!);
    expect(location.origin).toBe(BASE);
    expect(location.searchParams.get("next")).toBeNull();
  });
});
