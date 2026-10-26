/**
 * /auth/confirm: the emailed link (GET) only shows a "Continue signing in"
 * page; signing in takes the form's POST, from this site.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ verifyOtp: vi.fn(async (_args: unknown) => ({ error: null as { message: string } | null })) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ auth: { verifyOtp: fake.verifyOtp } }) }));

import { GET, POST } from "./route";

const BASE = "http://localhost:3000";

function post(fields: Record<string, string>, headers: Record<string, string> = { origin: BASE }) {
  return POST(
    new Request(`${BASE}/auth/confirm`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams(fields),
    }),
  );
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

describe("GET (the emailed link)", () => {
  it("shows a page with a form that posts the token back, and doesn't sign in", async () => {
    const res = await GET(new Request(`${BASE}/auth/confirm?token_hash=abc123&type=email&next=%2Fwardrobe`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    const html = await res.text();
    expect(html).toContain('<form method="post" action="/auth/confirm">');
    expect(html).toContain('name="token_hash" value="abc123"');
    expect(html).toContain('name="type" value="email"');
    expect(html).toContain('name="next" value="/wardrobe"');
    expect(html).toContain("Continue signing in");
    expect(html).not.toContain("<script");
    expect(fake.verifyOtp).not.toHaveBeenCalled();
  });

  it("never puts unsafe text into the page", async () => {
    const res = await GET(new Request(`${BASE}/auth/confirm?token_hash=%22%3E%3Cscript%3E&type=email&next=%2F%22%3E%3Cb%3E`));
    const text = res.status === 200 ? await res.text() : "";
    expect(text).not.toContain("<script>");
    expect(text).not.toContain('"><b>');
  });

  it("goes to /sign-in?error=link without a usable token or type", async () => {
    for (const query of ["", "?token_hash=abc", "?type=email", "?token_hash=abc&type=recovery"]) {
      const res = await GET(new Request(`${BASE}/auth/confirm${query}`));
      const location = new URL(res.headers.get("location")!);
      expect(location.pathname).toBe("/sign-in");
      expect(location.searchParams.get("error")).toBe("link");
    }
    expect(fake.verifyOtp).not.toHaveBeenCalled();
  });
});

describe("POST (the form)", () => {
  it("signs in and goes to next", async () => {
    const res = await post({ token_hash: "abc123", type: "email", next: "/wardrobe" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${BASE}/wardrobe`);
    expect(fake.verifyOtp).toHaveBeenCalledWith({ token_hash: "abc123", type: "email" });
  });

  it("goes back to /sign-in?error=link if the token doesn't work", async () => {
    fake.verifyOtp.mockResolvedValueOnce({ error: { message: "expired" } });
    const res = await post({ token_hash: "abc123", type: "email", next: "/wardrobe" });
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/sign-in");
    expect(location.searchParams.get("next")).toBe("/wardrobe");
  });

  it("accepts NEXT_PUBLIC_SITE_URL as the origin", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://gladrags.example");
    const res = await post({ token_hash: "abc123", type: "email" }, { origin: "https://gladrags.example" });
    expect(res.status).toBe(303);
    expect(fake.verifyOtp).toHaveBeenCalled();
  });

  it.each([
    ["another site's Origin", { origin: "https://evil.example" }],
    ["an opaque Origin", { origin: "null" }],
    ["no Origin but Sec-Fetch-Site cross-site", { "sec-fetch-site": "cross-site" }],
  ])("refuses %s with 403, without signing in", async (_label, headers) => {
    const res = await post({ token_hash: "abc123", type: "email" }, headers);
    expect(res.status).toBe(403);
    expect(fake.verifyOtp).not.toHaveBeenCalled();
  });

  it("refuses OTP types other than email sign-in", async () => {
    const res = await post({ token_hash: "abc123", type: "recovery" });
    expect(new URL(res.headers.get("location")!).pathname).toBe("/sign-in");
    expect(fake.verifyOtp).not.toHaveBeenCalled();
  });
});
