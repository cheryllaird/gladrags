/**
 * QA: the proxy skips session handling for the inbound email webhook
 * (milestone 5), and only for paths under /api/inbound/.
 */
import { NextRequest, NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ calls: 0 }));

vi.mock("@/lib/supabase/proxy", () => ({
  updateSession: async (request: NextRequest) => {
    session.calls++;
    return { response: NextResponse.next({ request }), user: null };
  },
}));

import { config, proxy } from "./proxy";

const BASE = "http://localhost:3000";
const visit = (path: string, init?: ConstructorParameters<typeof NextRequest>[1]) => proxy(new NextRequest(new URL(path, BASE), init));

beforeEach(() => {
  vi.stubEnv("GLADRAGS_MOCK_MODE", "false");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://qa-project.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_qa");
  session.calls = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the inbound webhook in the proxy", () => {
  it("is matched by the proxy (not excluded like a static file)", () => {
    const matcher = new RegExp(`^${config.matcher[0]}$`);
    expect(matcher.test("/api/inbound/email")).toBe(true);
  });

  it("skips the session for /api/inbound/email, and doesn't redirect", async () => {
    const res = await visit("/api/inbound/email", { method: "POST" });
    expect(session.calls).toBe(0);
    expect(res.headers.get("location")).toBeNull();
    expect(res.status).toBe(200);
  });

  it("still answers the webhook when Supabase isn't configured (the route checks its own secret)", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    const res = await visit("/api/inbound/email", { method: "POST" });
    expect(res.status).toBe(200);
  });

  it.each([
    "/api/inbound",
    "/api/inboundx/email",
    "/api/inbound-email",
    "/api/settings",
    "/api/email-imports",
    "/api/items/reviewed",
    "/api/inbound/../settings",
    "/api/inbound/%2e%2e/settings",
    "/inbound/email",
    "/api/x/api/inbound/email",
  ])("keeps session handling for %s", async (path) => {
    // Dot segments (plain or %2e-encoded) are resolved by the URL parser
    // before the proxy sees the path, so they can't borrow the exemption.
    await visit(path);
    expect(session.calls).toBe(1);
  });
});
