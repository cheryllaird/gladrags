/**
 * QA: the API routes with mock mode OFF, with Supabase replaced by an
 * in-test fake (no network). Checks that:
 * - every route needs a signed-in user (401 in the documented error shape),
 * - stubs still validate input (400) but never serve mock data (501),
 * - sign-in enforces the allowlist and only redirects within the site.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { API_ERROR_STATUS, ApiErrorSchema } from "@/contracts";
import { MOCK_SUGGESTED_TAGS } from "@/lib/mocks/fixtures";

const fake = vi.hoisted(() => ({
  user: null as { id: string; email: string } | null,
  allowed: true as boolean | "error",
  signInWithOtp: vi.fn(async (_args: unknown) => ({ error: null as null | { status: number; message: string } })),
  verifyOtp: vi.fn(async (_args: unknown) => ({ error: null as null | { message: string } })),
  exchangeCodeForSession: vi.fn(async (_code: string) => ({ error: null as null | { message: string } })),
  signOut: vi.fn(async () => ({ error: null })),
  rpc: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: fake.user } }),
      signInWithOtp: fake.signInWithOtp,
      verifyOtp: fake.verifyOtp,
      exchangeCodeForSession: fake.exchangeCodeForSession,
      signOut: fake.signOut,
    },
  }),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async (name: string, args: unknown) => {
      fake.rpc(name, args);
      if (name !== "is_email_allowed") throw new Error(`unexpected rpc ${name}`);
      if (fake.allowed === "error") return { data: null, error: { message: "db down" } };
      return { data: fake.allowed, error: null };
    },
  }),
}));

import * as account from "./account/route";
import * as magicLink from "./auth/magic-link/route";
import * as signOut from "./auth/sign-out/route";
import * as verifyCode from "./auth/verify-code/route";
import * as itemById from "./items/[id]/route";
import * as itemLinkCutout from "./items/link/cutout/route";
import * as itemLink from "./items/link/route";
import * as itemPhoto from "./items/photo/route";
import * as items from "./items/route";
import * as refine from "./outfits/[id]/refine/route";
import * as outfitById from "./outfits/[id]/route";
import * as outfits from "./outfits/route";
import * as usage from "./usage/route";
import * as authCallback from "../auth/callback/route";
import * as authConfirm from "../auth/confirm/route";

const BASE = "http://localhost:3000";
const USER = { id: "0c000000-0000-4000-8000-000000000003", email: "tester@example.com" };
const ID = "1a000000-0000-4000-8000-000000000001";
const ctx = (id = ID) => ({ params: Promise.resolve({ id }) });
const KEY = (ext: string) => `${USER.id}/1a000000-0000-4000-8000-000000000099.${ext}`;
const TAGS = MOCK_SUGGESTED_TAGS;

function json(path: string, method: string, body?: unknown): Request {
  return new Request(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function multipart(path: string, fields: Record<string, File | string>): Request {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  return new Request(`${BASE}${path}`, { method: "POST", body });
}

const jpeg = () => new File([Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])], "a.jpg", { type: "image/jpeg" });
const png = () => new File([Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], "a.png", { type: "image/png" });

async function expectError(response: Response, code: keyof typeof API_ERROR_STATUS) {
  expect(response.status).toBe(API_ERROR_STATUS[code]);
  const body = ApiErrorSchema.parse(await response.json());
  expect(body.error.code).toBe(code);
  expect(body.error.message.length).toBeGreaterThan(0);
  return body.error;
}

/** One valid call per route, so only auth / the stub gate can stop it. */
const VALID_CALLS: [string, () => Promise<Response>][] = [
  ["GET /api/items", () => items.GET(json("/api/items", "GET"))],
  [
    "POST /api/items",
    () =>
      items.POST(
        json("/api/items", "POST", {
          source: "photo",
          sourceUrl: null,
          originalImageKey: KEY("jpg"),
          cutoutImageKey: null,
          tags: TAGS,
          tagsEdited: false,
        }),
      ),
  ],
  ["GET /api/items/[id]", () => itemById.GET(json(`/api/items/${ID}`, "GET"), ctx())],
  ["PATCH /api/items/[id]", () => itemById.PATCH(json(`/api/items/${ID}`, "PATCH", { tags: TAGS }), ctx())],
  ["DELETE /api/items/[id]", () => itemById.DELETE(json(`/api/items/${ID}`, "DELETE"), ctx())],
  ["POST /api/items/photo", () => itemPhoto.POST(multipart("/api/items/photo", { original: jpeg(), cutout: png() }))],
  ["POST /api/items/link", () => itemLink.POST(json("/api/items/link", "POST", { url: "https://shop.example.com/p/1" }))],
  [
    "POST /api/items/link/cutout",
    () =>
      itemLinkCutout.POST(
        multipart("/api/items/link/cutout", {
          meta: JSON.stringify({
            sourceUrl: "https://shop.example.com/p/1",
            originalImageKey: KEY("jpg"),
            product: { title: null, brand: null, colour: null },
          }),
        }),
      ),
  ],
  ["GET /api/outfits", () => outfits.GET(json("/api/outfits?status=saved", "GET"))],
  ["POST /api/outfits", () => outfits.POST(json("/api/outfits", "POST", { style: { kind: "preset", presetId: "work" } }))],
  ["GET /api/outfits/[id]", () => outfitById.GET(json(`/api/outfits/${ID}`, "GET"), ctx())],
  ["PATCH /api/outfits/[id]", () => outfitById.PATCH(json(`/api/outfits/${ID}`, "PATCH", { status: "liked" }), ctx())],
  [
    "POST /api/outfits/[id]/refine",
    () => refine.POST(json(`/api/outfits/${ID}/refine`, "POST", { kind: "guidance", text: "warmer" }), ctx()),
  ],
];

beforeEach(() => {
  vi.stubEnv("GLADRAGS_MOCK_MODE", "false");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://qa-project.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_qa");
  vi.stubEnv("SUPABASE_SECRET_KEY", "sb_secret_qa");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
  fake.user = null;
  fake.allowed = true;
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("signed out", () => {
  it.each([
    ...VALID_CALLS,
    ["GET /api/usage", () => usage.GET(json("/api/usage", "GET"))],
    ["DELETE /api/account", () => account.DELETE(json("/api/account", "DELETE"))],
  ] as [string, () => Promise<Response>][])("%s returns 401 unauthorized", async (_label, call) => {
    await expectError(await call(), "unauthorized");
  });

  it("rejects before reading the body: a bad body still gets 401, not 400", async () => {
    await expectError(await outfits.POST(json("/api/outfits", "POST", { style: "nonsense" })), "unauthorized");
  });
});

describe("signed in, mock mode off", () => {
  beforeEach(() => {
    fake.user = USER;
  });

  it.each(VALID_CALLS)("stub %s refuses with 501 not_implemented instead of mock data", async (_label, call) => {
    const error = await expectError(await call(), "not_implemented");
    expect(JSON.stringify(error)).not.toContain("mock");
  });

  it.each([
    ["GET /api/items with a bad filter", () => items.GET(json("/api/items?colour=dusty_heather", "GET"))],
    ["POST /api/outfits with count 9", () => outfits.POST(json("/api/outfits", "POST", { style: { kind: "preset", presetId: "work" }, count: 9 }))],
    ["PATCH /api/outfits/[id] with status loved", () => outfitById.PATCH(json(`/api/outfits/${ID}`, "PATCH", { status: "loved" }), ctx())],
    ["POST /api/items/photo with a GIF", () => itemPhoto.POST(multipart("/api/items/photo", { original: new File(["GIF89a"], "a.gif") }))],
    ["POST /api/items/link with ftp", () => itemLink.POST(json("/api/items/link", "POST", { url: "ftp://shop.example.com" }))],
    ["POST /api/outfits/[id]/refine with no kind", () => refine.POST(json(`/api/outfits/${ID}/refine`, "POST", { text: "x" }), ctx())],
  ] as [string, () => Promise<Response>][])("still validates input: %s -> 400 with issues", async (_label, call) => {
    const error = await expectError(await call(), "bad_request");
    expect(error.issues?.length ?? 0).toBeGreaterThan(0);
  });

  it("refuses to save images from another user's folder before the stub gate", async () => {
    const res = await items.POST(
      json("/api/items", "POST", {
        source: "photo",
        sourceUrl: null,
        originalImageKey: `0b000000-0000-4000-8000-000000000002/1a000000-0000-4000-8000-000000000099.jpg`,
        cutoutImageKey: null,
        tags: TAGS,
        tagsEdited: false,
      }),
    );
    await expectError(res, "bad_request");
  });

  it("returns 404 (not 400) for a malformed route ID", async () => {
    await expectError(await itemById.GET(json("/api/items/abc", "GET"), ctx("abc")), "not_found");
    await expectError(await outfitById.GET(json("/api/outfits/abc", "GET"), ctx("../../etc")), "not_found");
  });

  it("turns a missing secret key into server_misconfigured (500) without naming the variable", async () => {
    vi.stubEnv("SUPABASE_SECRET_KEY", "");
    const { getSupabaseSecretEnv } = await import("@/lib/env.server");
    const { withApiHandler } = await import("@/lib/api/http");
    const route = withApiHandler(async () => {
      getSupabaseSecretEnv();
      return new Response("unreachable");
    });
    const error = await expectError(await route(json("/api/usage", "GET")), "server_misconfigured");
    expect(error.message).not.toMatch(/SUPABASE|secret/i);
  });
});

describe("POST /api/auth/magic-link (allowlist)", () => {
  it("turns away an email that isn't on the allowlist, without sending anything", async () => {
    fake.allowed = false;
    const res = await magicLink.POST(json("/api/auth/magic-link", "POST", { email: "  Stranger@Example.com " }));
    await expectError(res, "not_invited");
    expect(fake.rpc).toHaveBeenCalledWith("is_email_allowed", { p_email: "stranger@example.com" });
    expect(fake.signInWithOtp).not.toHaveBeenCalled();
  });

  it("sends the link to an allowlisted email with a same-site callback carrying next", async () => {
    const res = await magicLink.POST(json("/api/auth/magic-link", "POST", { email: "Tester@Example.com", next: "/outfits?style=work" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: true });
    const args = fake.signInWithOtp.mock.calls[0]![0] as { email: string; options: { emailRedirectTo: string } };
    expect(args.email).toBe("tester@example.com");
    const callback = new URL(args.options.emailRedirectTo);
    expect(callback.origin).toBe(BASE);
    expect(callback.pathname).toBe("/auth/callback");
    expect(callback.searchParams.get("next")).toBe("/outfits?style=work");
  });

  it("uses NEXT_PUBLIC_SITE_URL for the email link when set", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://gladrags-preview.vercel.app/");
    await magicLink.POST(json("/api/auth/magic-link", "POST", { email: "tester@example.com" }));
    const args = fake.signInWithOtp.mock.calls[0]![0] as { options: { emailRedirectTo: string } };
    expect(args.options.emailRedirectTo).toBe("https://gladrags-preview.vercel.app/auth/callback");
  });

  it("rejects an off-site next before checking the allowlist", async () => {
    const res = await magicLink.POST(json("/api/auth/magic-link", "POST", { email: "tester@example.com", next: "//evil.example.com" }));
    await expectError(res, "bad_request");
    expect(fake.rpc).not.toHaveBeenCalled();
  });

  it("returns internal (500) without leaking details when the allowlist check fails", async () => {
    fake.allowed = "error";
    const error = await expectError(await magicLink.POST(json("/api/auth/magic-link", "POST", { email: "tester@example.com" })), "internal");
    expect(error.message).not.toMatch(/db down/);
    expect(fake.signInWithOtp).not.toHaveBeenCalled();
  });

  it("returns internal (500) with a retry message when Supabase refuses to send", async () => {
    fake.signInWithOtp.mockResolvedValueOnce({ error: { status: 429, message: "rate limited" } });
    const error = await expectError(await magicLink.POST(json("/api/auth/magic-link", "POST", { email: "tester@example.com" })), "internal");
    expect(error.message).toMatch(/try again/i);
  });
});

describe("POST /api/auth/verify-code", () => {
  it("returns unauthorized for a wrong or expired code", async () => {
    fake.verifyOtp.mockResolvedValueOnce({ error: { message: "Token has expired or is invalid" } });
    const res = await verifyCode.POST(json("/api/auth/verify-code", "POST", { email: "tester@example.com", code: "123456" }));
    await expectError(res, "unauthorized");
  });

  it("signs in and defaults next to /", async () => {
    const res = await verifyCode.POST(json("/api/auth/verify-code", "POST", { email: "Tester@Example.com", code: " 123456 " }));
    expect(await res.json()).toEqual({ signedIn: true, next: "/" });
    expect(fake.verifyOtp).toHaveBeenCalledWith({ email: "tester@example.com", token: "123456", type: "email" });
  });

  it("never calls Supabase for a malformed code", async () => {
    await expectError(await verifyCode.POST(json("/api/auth/verify-code", "POST", { email: "tester@example.com", code: "12 34 56" })), "bad_request");
    expect(fake.verifyOtp).not.toHaveBeenCalled();
  });
});

describe("POST /api/auth/sign-out", () => {
  it("returns JSON for fetch and a 303 to /sign-in for a form post", async () => {
    const res = await signOut.POST(json("/api/auth/sign-out", "POST"));
    expect(await res.json()).toEqual({ signedOut: true });
    const formPost = new Request(`${BASE}/api/auth/sign-out`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "",
    });
    const redirect = await signOut.POST(formPost);
    expect(redirect.status).toBe(303);
    expect(redirect.headers.get("location")).toBe(`${BASE}/sign-in`);
    expect(fake.signOut).toHaveBeenCalledTimes(2);
  });
});

describe("/auth/callback and /auth/confirm only redirect within the site", () => {
  const tricky = [
    "//evil.example.com",
    "/\\evil.example.com",
    "https://evil.example.com",
    "/%2F%2Fevil.example.com",
    "/\t/evil.example.com",
    "javascript:alert(1)",
    "/@evil.example.com",
  ];

  it.each(tricky)("callback with next=%j stays on this origin", async (next) => {
    const res = await authCallback.GET(new Request(`${BASE}/auth/callback?code=abc&next=${encodeURIComponent(next)}`));
    const location = new URL(res.headers.get("location")!);
    expect(location.origin).toBe(BASE);
  });

  it.each(tricky)("confirm with next=%j stays on this origin", async (next) => {
    const res = await authConfirm.GET(new Request(`${BASE}/auth/confirm?token_hash=abc&type=email&next=${encodeURIComponent(next)}`));
    expect(new URL(res.headers.get("location")!).origin).toBe(BASE);
  });

  it("callback goes to next after a good code, and to /sign-in?error=link after a bad one", async () => {
    const good = await authCallback.GET(new Request(`${BASE}/auth/callback?code=abc&next=%2Fwardrobe`));
    expect(good.headers.get("location")).toBe(`${BASE}/wardrobe`);
    fake.exchangeCodeForSession.mockResolvedValueOnce({ error: { message: "bad code" } });
    const bad = await authCallback.GET(new Request(`${BASE}/auth/callback?code=abc&next=%2Fwardrobe`));
    const location = new URL(bad.headers.get("location")!);
    expect(location.pathname).toBe("/sign-in");
    expect(location.searchParams.get("error")).toBe("link");
    expect(location.searchParams.get("next")).toBe("/wardrobe");
  });

  it("callback without a code doesn't try to sign in", async () => {
    const res = await authCallback.GET(new Request(`${BASE}/auth/callback`));
    expect(new URL(res.headers.get("location")!).pathname).toBe("/sign-in");
    expect(fake.exchangeCodeForSession).not.toHaveBeenCalled();
  });

  it("confirm refuses OTP types other than email sign-in (e.g. recovery)", async () => {
    const res = await authConfirm.GET(new Request(`${BASE}/auth/confirm?token_hash=abc&type=recovery`));
    expect(new URL(res.headers.get("location")!).pathname).toBe("/sign-in");
    expect(fake.verifyOtp).not.toHaveBeenCalled();
  });
});
