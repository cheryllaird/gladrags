/**
 * QA: /privacy is the only new public path. Signed-out visitors reach it
 * (and its Back link, which goes to "/", lands on sign-in); anything that
 * merely looks like it, or climbs out of it, still needs sign-in.
 */
import { NextRequest, NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ user: null as { id: string } | null }));

vi.mock("@/lib/supabase/proxy", () => ({
  updateSession: async (request: NextRequest) => ({
    response: NextResponse.next({ request }),
    user: session.user,
  }),
}));

import { proxy } from "./proxy";

const visit = (path: string) =>
  proxy(new NextRequest(new URL(path, "http://localhost:3000")));

async function redirectedTo(path: string): Promise<string | null> {
  const location = (await visit(path)).headers.get("location");
  return location ? new URL(location).pathname : null;
}

beforeEach(() => {
  vi.stubEnv("GLADRAGS_MOCK_MODE", "false");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://qa-project.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_qa");
  session.user = null;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("/privacy signed out", () => {
  it.each(["/privacy", "/privacy?next=%2Fwardrobe", "/privacy#gemini"])(
    "%s is shown without a redirect",
    async (path) => {
      expect(await redirectedTo(path)).toBeNull();
    },
  );

  it("its Back link ('/') goes to sign-in", async () => {
    expect(await redirectedTo("/")).toBe("/sign-in");
  });
});

describe("lookalike and climbing paths still need sign-in", () => {
  it.each([
    "/privacyx",
    "/privacy-note",
    "/privacy.json",
    "/privacy.html",
    "/privacy%2F..%2Fwardrobe",
    "/privacy%2fwardrobe",
    "/privacy;/wardrobe",
    "/privacy/../wardrobe",
    "/privacy/x",
    "/privacy/anything",
    "/privacy/./../add/link?url=https%3A%2F%2Fshop.example.com",
    "/privacy/%2e%2e/wardrobe",
    "/Privacy",
    "/PRIVACY",
    "/wardrobe/privacy",
    "/add/privacy",
    "/wardrobe?x=/privacy",
  ])("%s", async (path) => {
    expect(await redirectedTo(path)).toBe("/sign-in");
  });
});

describe("signed in", () => {
  it("/privacy passes straight through", async () => {
    session.user = { id: "0a000000-0000-4000-8000-000000000001" };
    expect(await redirectedTo("/privacy")).toBeNull();
  });
});
