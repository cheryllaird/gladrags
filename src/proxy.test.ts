/**
 * src/proxy.ts and the scheduled jobs: /api/cron/* is never sent to
 * sign-in and needs no session refresh (the route checks its own secret).
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

beforeEach(() => {
  vi.stubEnv("GLADRAGS_MOCK_MODE", "false");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://qa-project.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_qa");
  session.calls = 0;
});

afterEach(() => vi.unstubAllEnvs());

describe("scheduled jobs", () => {
  it("/api/cron/cleanup passes straight through, signed out, without a session refresh", async () => {
    const res = await proxy(new NextRequest(new URL("http://localhost:3000/api/cron/cleanup")));
    expect(res.headers.get("location")).toBeNull();
    expect(res.status).toBe(200);
    expect(session.calls).toBe(0);
  });

  it("is still matched by the proxy (so nothing else about it changes silently)", () => {
    const matcher = new RegExp(`^${config.matcher[0]}$`);
    expect(matcher.test("/api/cron/cleanup")).toBe(true);
  });

  it("only the /api/cron/ prefix is skipped", async () => {
    await proxy(new NextRequest(new URL("http://localhost:3000/api/cronjob")));
    expect(session.calls).toBe(1);
  });
});
