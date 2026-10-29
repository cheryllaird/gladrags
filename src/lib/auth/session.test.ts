import { afterEach, describe, expect, it, vi } from "vitest";

const supabase = vi.hoisted(() => ({ getUser: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: supabase.getUser } }),
}));

import { getSessionUserOrNull } from "./session";

afterEach(() => {
  vi.unstubAllEnvs();
  supabase.getUser.mockReset();
});

describe("getSessionUserOrNull", () => {
  it("returns the signed-in user", async () => {
    vi.stubEnv("GLADRAGS_MOCK_MODE", "false");
    supabase.getUser.mockResolvedValue({ data: { user: { id: "u1", email: "a@example.com" } } });
    await expect(getSessionUserOrNull()).resolves.toEqual({ id: "u1", email: "a@example.com" });
  });

  it("returns null when the user can't be read", async () => {
    vi.stubEnv("GLADRAGS_MOCK_MODE", "false");
    supabase.getUser.mockRejectedValue(new Error("Supabase is down"));
    await expect(getSessionUserOrNull()).resolves.toBeNull();
  });

  it("re-throws Next's dynamic-rendering signal, so the page isn't pre-rendered with no user", async () => {
    vi.stubEnv("GLADRAGS_MOCK_MODE", "false");
    // What cookies() throws while Next pre-renders a page at build time.
    const signal = Object.assign(new Error("Dynamic server usage: cookies"), { digest: "DYNAMIC_SERVER_USAGE" });
    supabase.getUser.mockRejectedValue(signal);
    await expect(getSessionUserOrNull()).rejects.toBe(signal);
  });
});
