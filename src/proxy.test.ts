/**
 * The tester privacy note (/privacy) is public: signed-out visitors, and
 * the sign-in page's link to it, must reach it without being sent to
 * /sign-in. It's public by exact path only: lookalikes, and anything under
 * it (/privacy/x), still need sign-in. (The rest of the proxy is
 * covered by qa-proxy.test.ts.)
 */
import { NextRequest, NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/proxy", () => ({
  updateSession: async (request: NextRequest) => ({ response: NextResponse.next({ request }), user: null }),
}));

import { config, proxy } from "./proxy";

const visit = (path: string) => proxy(new NextRequest(new URL(path, "http://localhost:3000")));

beforeEach(() => {
  vi.stubEnv("GLADRAGS_MOCK_MODE", "false");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://qa-project.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_qa");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("/privacy for signed-out visitors", () => {
  it.each(["/privacy", "/privacy?from=sign-in"])("shows %s without a redirect", async (path) => {
    const res = await visit(path);
    expect(res.headers.get("location")).toBeNull();
    expect(res.status).toBe(200);
  });

  it("runs the proxy on /privacy (so the session is still refreshed there)", () => {
    expect(new RegExp(`^${config.matcher[0]!}$`).test("/privacy")).toBe(true);
  });

  it.each(["/privacyx", "/privacy-policy", "/privacy.html", "/privacy/x", "/privacy/x/y"])("still sends lookalike %s to sign-in", async (path) => {
    const location = (await visit(path)).headers.get("location");
    expect(location && new URL(location).pathname).toBe("/sign-in");
  });
});
