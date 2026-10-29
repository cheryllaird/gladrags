/**
 * QA: src/proxy.ts sends signed-out visitors to /sign-in (keeping where
 * they were going), leaves the public pages and the API alone, and fails
 * closed when Supabase isn't configured.
 */
import { NextRequest, NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({
  user: null as { id: string } | null,
  calls: 0,
}));

vi.mock("@/lib/supabase/proxy", () => ({
  updateSession: async (request: NextRequest) => {
    session.calls++;
    return { response: NextResponse.next({ request }), user: session.user };
  },
}));

import { config, proxy } from "./proxy";

const BASE = "http://localhost:3000";
const visit = (path: string) => proxy(new NextRequest(new URL(path, BASE)));

function redirectTarget(res: Response): URL | null {
  const location = res.headers.get("location");
  return location ? new URL(location) : null;
}

beforeEach(() => {
  vi.stubEnv("GLADRAGS_MOCK_MODE", "false");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://qa-project.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_qa");
  session.user = null;
  session.calls = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("signed-out visitors", () => {
  it.each(["/wardrobe", "/outfits/saved", "/add/link", "/items/1a000000-0000-4000-8000-000000000001"])(
    "are redirected from %s to /sign-in with next",
    async (path) => {
      const res = await visit(path);
      expect([302, 303, 307, 308]).toContain(res.status);
      const target = redirectTarget(res)!;
      expect(target.origin).toBe(BASE);
      expect(target.pathname).toBe("/sign-in");
      expect(target.searchParams.get("next")).toBe(path);
    },
  );

  it("keep the query string in next (Android share target /add/link?url=...)", async () => {
    const res = await visit("/add/link?url=https%3A%2F%2Fshop.example.com%2Fp%2F1");
    expect(redirectTarget(res)!.searchParams.get("next")).toBe("/add/link?url=https%3A%2F%2Fshop.example.com%2Fp%2F1");
  });

  it("are redirected from / without a next parameter", async () => {
    const target = redirectTarget(await visit("/"))!;
    expect(target.pathname).toBe("/sign-in");
    expect(target.search).toBe("");
  });

  it("don't carry the original query onto /sign-in itself", async () => {
    const target = redirectTarget(await visit("/wardrobe?error=link"))!;
    expect(target.searchParams.get("error")).toBeNull();
  });

  it.each(["/sign-in", "/sign-in?next=%2Fwardrobe", "/auth/callback?code=x", "/auth/confirm?token_hash=x&type=email", "/api/auth/magic-link", "/offline.html"])(
    "can reach public path %s",
    async (path) => {
      const res = await visit(path);
      expect(redirectTarget(res)).toBeNull();
      expect(res.status).toBe(200);
    },
  );

  it.each(["/api/items", "/api/outfits", "/api/usage"])("are not redirected from API route %s (it answers 401 itself)", async (path) => {
    expect(redirectTarget(await visit(path))).toBeNull();
  });

  it.each(["/sign-inx", "/sign-in-help", "/authx", "/auth", "/offline.html.bak"])(
    "can't use a lookalike of a public path (%s) to skip sign-in",
    async (path) => {
      expect(redirectTarget(await visit(path))?.pathname).toBe("/sign-in");
    },
  );
});

describe("signed-in users", () => {
  it("pass straight through", async () => {
    session.user = { id: "u1" };
    for (const path of ["/", "/wardrobe", "/sign-in"]) {
      const res = await visit(path);
      expect(redirectTarget(res)).toBeNull();
    }
    expect(session.calls).toBe(3);
  });
});

describe("configuration", () => {
  it("skips auth entirely in mock mode", async () => {
    vi.stubEnv("GLADRAGS_MOCK_MODE", "true");
    const res = await visit("/wardrobe");
    expect(redirectTarget(res)).toBeNull();
    expect(session.calls).toBe(0);
  });

  it("treats GLADRAGS_MOCK_MODE values other than exactly 'true' as off", async () => {
    for (const value of ["TRUE", "1", "yes", " true"]) {
      vi.stubEnv("GLADRAGS_MOCK_MODE", value);
      expect(redirectTarget(await visit("/wardrobe"))?.pathname).toBe("/sign-in");
    }
  });

  it("fails closed with a 500 when Supabase isn't configured", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    const res = await visit("/wardrobe");
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).toMatch(/isn't configured/);
    expect(text).toContain("NEXT_PUBLIC_SUPABASE_URL");
    expect(session.calls).toBe(0);
  });

  it("names a misconfigured variable but never shows its value", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "not-a-url-but-a-secret-looking-value");
    const res = await visit("/wardrobe");
    const text = await res.text();
    expect(res.status).toBe(500);
    expect(text).toContain("NEXT_PUBLIC_SUPABASE_URL");
    expect(text).not.toContain("secret-looking-value");
  });
});

describe("matcher", () => {
  const pattern = new RegExp(`^${config.matcher[0]!}$`);

  it.each(["/", "/wardrobe", "/api/items", "/sign-in", "/auth/callback"])("runs on %s", (path) => {
    expect(pattern.test(path)).toBe(true);
  });

  it.each([
    "/_next/static/chunk.js",
    "/icons/icon-192.png",
    "/mock/items/blue-jeans.svg",
    "/sw.js",
    "/manifest.webmanifest",
    "/models/u2netp.onnx",
    "/ort/ort-wasm-simd-threaded.wasm",
  ])(
    "skips static asset %s",
    (path) => {
      expect(pattern.test(path)).toBe(false);
    },
  );
});
