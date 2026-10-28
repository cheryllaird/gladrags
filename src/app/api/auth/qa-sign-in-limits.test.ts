/**
 * QA (fix/hardening): the sign-in rate limits through the real routes with
 * mock mode OFF (Supabase auth and the allowlist faked, the attempt store
 * in memory with a controllable clock).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiErrorSchema } from "@/contracts";

const fake = vi.hoisted(() => ({
  invited: new Set<string>(["tester@example.com"]),
  store: null as unknown as import("@/lib/auth/rate-limit").InMemorySignInAttemptStore,
  signInWithOtp: vi.fn(async (_args: unknown) => ({ error: null as null | { status: number; message: string } })),
  verifyOtp: vi.fn(async (_args: unknown) => ({ error: null as null | { message: string } })),
  allowlistChecks: 0,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { signInWithOtp: fake.signInWithOtp, verifyOtp: fake.verifyOtp } }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async (name: string, args: { p_email: string }) => {
      if (name !== "is_email_allowed") throw new Error(`unexpected rpc ${name}`);
      fake.allowlistChecks++;
      return { data: fake.invited.has(args.p_email), error: null };
    },
  }),
}));
vi.mock("@/lib/auth/rate-limit", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/auth/rate-limit")>();
  return { ...original, getSignInAttemptStore: () => fake.store };
});

import { InMemorySignInAttemptStore } from "@/lib/auth/rate-limit";
import * as magicLink from "./magic-link/route";
import * as verifyCode from "./verify-code/route";

const BASE = "http://localhost:3000";

function magic(email: string, headers: Record<string, string> = {}) {
  return magicLink.POST(
    new Request(`${BASE}/api/auth/magic-link`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE, ...headers },
      body: JSON.stringify({ email }),
    }),
  );
}

function verify(email: string, code: string, headers: Record<string, string> = {}) {
  return verifyCode.POST(
    new Request(`${BASE}/api/auth/verify-code`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE, ...headers },
      body: JSON.stringify({ email, code }),
    }),
  );
}

async function answer(res: Response) {
  return { status: res.status, body: (await res.json()) as unknown };
}

async function codeOf(res: Response) {
  return ApiErrorSchema.parse(await res.json()).error.code;
}

const advance = (minutes: number) => vi.setSystemTime(Date.now() + minutes * 60_000);

beforeEach(() => {
  vi.stubEnv("GLADRAGS_MOCK_MODE", "false");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://qa-project.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_qa");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", BASE);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-26T12:00:00Z"));
  fake.store = new InMemorySignInAttemptStore();
  fake.signInWithOtp.mockClear();
  fake.verifyOtp.mockReset();
  fake.verifyOtp.mockResolvedValue({ error: null });
  fake.allowlistChecks = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("per email (5 in 15 minutes)", () => {
  it("the 6th magic link is a 429, and Supabase and the allowlist aren't asked", async () => {
    for (let i = 0; i < 5; i++) expect((await magic("tester@example.com")).status).toBe(200);
    const checksBefore = fake.allowlistChecks;
    const res = await magic("tester@example.com");
    expect(res.status).toBe(429);
    expect(await codeOf(res)).toBe("rate_limited");
    expect(fake.signInWithOtp).toHaveBeenCalledTimes(5);
    expect(fake.allowlistChecks).toBe(checksBefore);
  });

  it("case and surrounding spaces don't give an email extra attempts", async () => {
    const variants = ["tester@example.com", "Tester@Example.com", "  TESTER@EXAMPLE.COM  ", "tester@EXAMPLE.com", "TeStEr@example.com"];
    for (const email of variants) expect((await magic(email)).status).toBe(200);
    expect((await magic("tester@example.com ")).status).toBe(429);
  });

  it("plus-addressed and dotted variants are separate emails: each needs its own allowlist row, so none can be used to flood the tester's inbox", async () => {
    for (let i = 0; i < 5; i++) await magic("tester@example.com");
    for (const variant of ["tester+1@example.com", "tes.ter@example.com"]) {
      const res = await magic(variant);
      expect(res.status).toBe(403);
      expect(await codeOf(res)).toBe("not_invited");
    }
    expect(fake.signInWithOtp).toHaveBeenCalledTimes(5);
  });

  it("invited and uninvited emails get identical answers at the limit and over it", async () => {
    const invited: unknown[] = [];
    const uninvited: unknown[] = [];
    for (let i = 0; i < 8; i++) {
      invited.push(await answer(await magic("tester@example.com")));
      uninvited.push(await answer(await magic("stranger@example.com")));
    }
    // Under the limit they differ by design (sent vs not_invited)...
    expect(invited[0]).not.toEqual(uninvited[0]);
    // ...but the 6th, 7th and 8th answers are the same.
    expect(invited.slice(5)).toEqual(uninvited.slice(5));
    expect((invited[5] as { status: number }).status).toBe(429);
  });

  it("the window slides: the 6th is refused until the first attempt is 15 minutes old, then allowed", async () => {
    await magic("tester@example.com");
    advance(5);
    for (let i = 0; i < 4; i++) await magic("tester@example.com");
    advance(9);
    const refused = await magic("tester@example.com");
    expect(refused.status).toBe(429);
    expect(ApiErrorSchema.parse(await refused.json()).error.message).toMatch(/Wait 1 minute and try again/);
    advance(1.1); // the first attempt is now just over 15 minutes old
    expect((await magic("tester@example.com")).status).toBe(200);
    // The other four are still inside the window: only one more place opened.
    expect((await magic("tester@example.com")).status).toBe(429);
  });

  it("a refusal says how long to wait, in whole minutes", async () => {
    for (let i = 0; i < 5; i++) await magic("tester@example.com");
    const res = await magic("tester@example.com");
    expect(ApiErrorSchema.parse(await res.json()).error.message).toBe("Too many sign-in attempts. Wait 15 minutes and try again.");
  });

  it("magic links and code checks are limited separately", async () => {
    for (let i = 0; i < 5; i++) await magic("tester@example.com");
    expect((await verify("tester@example.com", "123456")).status).toBe(200);
  });
});

describe("code checks", () => {
  it("5 wrong codes, then the 6th (even the right one) is refused without asking Supabase", async () => {
    fake.verifyOtp.mockResolvedValue({ error: { message: "Token has expired or is invalid" } });
    for (let i = 0; i < 5; i++) expect((await verify("tester@example.com", String(100000 + i))).status).toBe(401);
    fake.verifyOtp.mockResolvedValue({ error: null });
    const res = await verify("tester@example.com", "424242");
    expect(res.status).toBe(429);
    expect(fake.verifyOtp).toHaveBeenCalledTimes(5);
  });

  // FINDING (low, a trade-off worth knowing): the limit is per email, not
  // per caller, so anyone who knows a tester's address can lock them out of
  // signing in (both routes) for 15 minutes at a time with 5 requests each,
  // from any IP. The per-IP limit doesn't help the victim.
  it("FINDING: five junk guesses from an attacker's IP lock the real tester out from her own IP", async () => {
    fake.verifyOtp.mockResolvedValue({ error: { message: "invalid" } });
    for (let i = 0; i < 5; i++) await verify("tester@example.com", "000000", { "x-real-ip": "198.51.100.66" });
    fake.verifyOtp.mockResolvedValue({ error: null });
    const res = await verify("tester@example.com", "123456", { "x-real-ip": "203.0.113.7" });
    expect(res.status).toBe(429);
  });
});

describe("per IP address (20 in 15 minutes, across emails)", () => {
  it("the 21st request from one IP is refused, even for a fresh invited email", async () => {
    fake.invited.add("second@example.com");
    for (let i = 0; i < 20; i++) await magic(`probe${i}@example.com`, { "x-real-ip": "203.0.113.9" });
    const res = await magic("second@example.com", { "x-real-ip": "203.0.113.9" });
    expect(res.status).toBe(429);
    expect((await magic("second@example.com", { "x-real-ip": "203.0.113.10" })).status).toBe(200);
  });

  it("an x-forwarded-for chain is keyed by its first entry", async () => {
    for (let i = 0; i < 20; i++) await magic(`probe${i}@example.com`, { "x-forwarded-for": `203.0.113.9, 10.0.0.${i}` });
    expect((await magic("probe99@example.com", { "x-forwarded-for": "203.0.113.9" })).status).toBe(429);
  });

  it("x-real-ip (set by Vercel) wins over a spoofed x-forwarded-for: rotating the spoofed header doesn't help", async () => {
    for (let i = 0; i < 20; i++) await magic(`probe${i}@example.com`, { "x-real-ip": "203.0.113.9", "x-forwarded-for": `192.0.2.${i}` });
    expect((await magic("probe99@example.com", { "x-real-ip": "203.0.113.9", "x-forwarded-for": "192.0.2.200" })).status).toBe(429);
  });

  // Off Vercel (or anywhere the platform doesn't set x-real-ip / overwrite
  // x-forwarded-for), the client chooses its own key. On Vercel both are
  // set by the edge, so this only matters if the app is hosted elsewhere.
  it("NOTE: without x-real-ip, a client rotating x-forwarded-for gets a fresh IP limit each time", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 30; i++) statuses.push((await magic(`probe${i}@example.com`, { "x-forwarded-for": `192.0.2.${i}` })).status);
    expect(statuses.filter((s) => s === 429)).toHaveLength(0);
  });

  // Was FINDING (low), fixed: IPv6 addresses were keyed in full, so a
  // client rotating through its own /64 got a fresh limit each time. They're
  // now keyed by their /64.
  it("all addresses in one IPv6 /64 share one limit; another /64 has its own", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 30; i++) statuses.push((await magic(`probe${i}@example.com`, { "x-real-ip": `2001:db8:1:2::${(i + 1).toString(16)}` })).status);
    expect(statuses.filter((s) => s === 429)).toHaveLength(10);
    expect((await magic("probe99@example.com", { "x-real-ip": "2001:db8:1:3::1" })).status).not.toBe(429);
  });

  it("no IP headers at all: only the per-email limit applies", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 25; i++) statuses.push((await magic(`probe${i}@example.com`)).status);
    expect(statuses.filter((s) => s === 429)).toHaveLength(0);
  });

  it("the IP window resets after 15 minutes", async () => {
    for (let i = 0; i < 20; i++) await magic(`probe${i}@example.com`, { "x-real-ip": "203.0.113.9" });
    expect((await magic("tester@example.com", { "x-real-ip": "203.0.113.9" })).status).toBe(429);
    advance(15.1);
    expect((await magic("tester@example.com", { "x-real-ip": "203.0.113.9" })).status).toBe(200);
  });

  it("a burst of 40 parallel requests from one IP lets exactly 20 through", async () => {
    const responses = await Promise.all(Array.from({ length: 40 }, (_, i) => magic(`probe${i}@example.com`, { "x-real-ip": "203.0.113.9" })));
    expect(responses.filter((r) => r.status !== 429)).toHaveLength(20);
  });
});
