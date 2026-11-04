/**
 * QA: the milestone 5 stubs outside mock mode. Every new route, and every
 * new option on an existing route, must answer 501 not_implemented (never
 * serve the shared in-memory mock data to real users) until its builder
 * ships it; signed-in routes must still answer 401 to a signed-out caller
 * first; and the inbound webhook alone works without a session.
 *
 * Routes whose builder has shipped them (BUILT) leave the 501 list but keep
 * the sign-in and cross-site checks. Their real behaviour is tested by
 * their builder (e.g. src/app/api/items/review-routes.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { API_ERROR_STATUS, ApiErrorSchema, type ApiErrorCode } from "@/contracts";
import { ApiException } from "@/lib/api/errors";

const session = vi.hoisted(() => ({ signedIn: true, calls: 0 }));

vi.mock("@/lib/auth/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/session")>();
  return {
    ...actual,
    requireUser: async () => {
      session.calls++;
      if (!session.signedIn) throw new ApiException("unauthorized", "Sign in first");
      return actual.MOCK_USER;
    },
  };
});

import * as emailImports from "./email-imports/route";
import * as inboundEmail from "./inbound/email/route";
import * as itemCutout from "./items/[id]/cutout/route";
import * as itemPhotoReplace from "./items/[id]/photo/route";
import * as itemById from "./items/[id]/route";
import * as itemLinkCutout from "./items/link/cutout/route";
import * as itemPhoto from "./items/photo/route";
import * as itemsReviewed from "./items/reviewed/route";
import * as items from "./items/route";
import * as forwardingAddress from "./settings/forwarding-address/route";
import * as settings from "./settings/route";

const BASE = "https://gladrags.example";
const ID = "1a000000-0000-4000-8000-000000000001";
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const IMAGE_KEY = `0a000000-0000-4000-8000-000000000001/${ID}.jpg`;

function json(path: string, method: string, body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
function form(path: string, method: string, fields: Record<string, string | File>): Request {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return new Request(`${BASE}${path}`, { method, body: data });
}
function fileOf(magic: number[], name: string, type: string): File {
  const bytes = new Uint8Array(1024);
  bytes.set(magic);
  return new File([bytes], name, { type });
}
const jpeg = () => fileOf([0xff, 0xd8, 0xff, 0xe0], "a.jpg", "image/jpeg");
const png = () => fileOf([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "a.png", "image/png");

async function expectError(response: Response, code: ApiErrorCode) {
  expect(response.status).toBe(API_ERROR_STATUS[code]);
  expect(ApiErrorSchema.parse(await response.json()).error.code).toBe(code);
}

const EMAIL = {
  messageId: "<1@mail.example>",
  from: "cheryl@example.com",
  to: ["0123456789abcdef0123456789abcdef@in.gladrags.example"],
  subject: "Fwd: order",
  text: "x",
  html: null,
  receivedAt: "2026-10-30T10:00:00.000Z",
  auth: { spf: "pass", dkim: "pass", dmarc: "pass" },
  spam: { isSpam: false, score: 0 },
};

/** Every new signed-in route or option, as a request it would otherwise accept. */
const ALL_CASES: [string, () => Promise<Response>][] = [
  ["GET /api/settings", () => settings.GET(json("/api/settings", "GET"))],
  ["PUT /api/settings", () => settings.PUT(json("/api/settings", "PUT", { favouriteShopIds: ["zara"] }))],
  ["POST /api/settings/forwarding-address", () => forwardingAddress.POST(json("/api/settings/forwarding-address", "POST"))],
  ["GET /api/email-imports", () => emailImports.GET(json("/api/email-imports", "GET"))],
  ["POST /api/items/reviewed", () => itemsReviewed.POST(json("/api/items/reviewed", "POST", { itemIds: [ID] }))],
  ["PUT /api/items/:id/cutout", () => itemCutout.PUT(form(`/api/items/${ID}/cutout`, "PUT", { cutout: png() }), ctx(ID))],
  ["PUT /api/items/:id/photo", () => itemPhotoReplace.PUT(form(`/api/items/${ID}/photo`, "PUT", { original: jpeg() }), ctx(ID))],
  // POST /api/outfits/:id/shop-search and PUT /api/outfits/:id/gaps/:category
  // are built (C4): src/app/api/outfits/shop-search-live.test.ts covers them
  // with mock mode off.
  ["GET /api/items?needsReview=true", () => items.GET(json("/api/items?needsReview=true", "GET"))],
  ["GET /api/items?needsReview=false", () => items.GET(json("/api/items?needsReview=false", "GET"))],
  ["PATCH /api/items/:id { reviewed: true }", () => itemById.PATCH(json(`/api/items/${ID}`, "PATCH", { reviewed: true }), ctx(ID))],
  ["POST /api/items/photo saveForReview=true", () => itemPhoto.POST(form("/api/items/photo", "POST", { original: jpeg(), saveForReview: "true" }))],
  [
    "POST /api/items/link/cutout { saveForReview: true }",
    () => itemLinkCutout.POST(form("/api/items/link/cutout", "POST", { meta: JSON.stringify({ originalImageKey: IMAGE_KEY, saveForReview: true }) })),
  ],
];

/** Built by ingestion (C2). */
const BUILT = new Set([
  "POST /api/items/reviewed",
  "PUT /api/items/:id/cutout",
  "PUT /api/items/:id/photo",
  "GET /api/items?needsReview=true",
  "GET /api/items?needsReview=false",
  "PATCH /api/items/:id { reviewed: true }",
  "POST /api/items/photo saveForReview=true",
]);
const CASES = ALL_CASES;
const STUB_CASES = ALL_CASES.filter(([name]) => !BUILT.has(name));

beforeEach(() => {
  vi.stubEnv("GLADRAGS_MOCK_MODE", "false");
  vi.stubEnv("INBOUND_EMAIL_DOMAIN", "in.gladrags.example");
  vi.stubEnv("INBOUND_EMAIL_WEBHOOK_SECRET", "");
  session.signedIn = true;
  session.calls = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("outside mock mode", () => {
  it("still lists every built route among the cases", () => {
    expect([...BUILT].every((name) => ALL_CASES.some(([n]) => n === name))).toBe(true);
  });

  it.each(STUB_CASES)("%s answers 501 not_implemented, not mock data", async (_name, call) => {
    await expectError(await call(), "not_implemented");
  });

  it.each(CASES)("%s answers 401 to a signed-out caller", async (_name, call) => {
    session.signedIn = false;
    await expectError(await call(), "unauthorized");
  });

  it.each(CASES.filter(([name]) => !name.startsWith("GET")))("%s refuses a cross-site request before anything else", async (_name, call) => {
    // Rebuild the request with a foreign Origin by wrapping fetch's Request.
    const original = globalThis.Request;
    class CrossSiteRequest extends original {
      constructor(input: RequestInfo | URL, init?: RequestInit) {
        const headers = new Headers(init?.headers);
        headers.set("origin", "https://evil.example");
        super(input, { ...init, headers });
      }
    }
    globalThis.Request = CrossSiteRequest as typeof Request;
    try {
      await expectError(await call(), "forbidden");
    } finally {
      globalThis.Request = original;
    }
    expect(session.calls).toBe(0);
  });
});

describe("the inbound webhook outside mock mode", () => {
  const post = (headers: Record<string, string> = {}) => inboundEmail.POST(json("/api/inbound/email", "POST", EMAIL, headers));

  it("needs no session: it never asks for the signed-in user", async () => {
    session.signedIn = false;
    vi.stubEnv("INBOUND_EMAIL_WEBHOOK_SECRET", "s".repeat(32));
    await expectError(await post(), "not_implemented");
    expect(session.calls).toBe(0);
  });

  it.each([[""], ["short"], ["s".repeat(31)]])("refuses everything while the secret is %j (too short or missing)", async (secret) => {
    vi.stubEnv("INBOUND_EMAIL_WEBHOOK_SECRET", secret);
    await expectError(await post(), "server_misconfigured");
  });

  it("never serves mock data, even for a perfect mock-mode email", async () => {
    vi.stubEnv("INBOUND_EMAIL_WEBHOOK_SECRET", "s".repeat(64));
    const res = await post();
    expect(res.status).toBe(501);
    expect(await res.text()).not.toContain("received");
  });

  it("refuses a browser post from another site", async () => {
    vi.stubEnv("INBOUND_EMAIL_WEBHOOK_SECRET", "s".repeat(32));
    await expectError(await post({ origin: "https://evil.example" }), "forbidden");
    await expectError(await post({ "sec-fetch-site": "cross-site" }), "forbidden");
  });

  it("the error doesn't echo the secret", async () => {
    vi.stubEnv("INBOUND_EMAIL_WEBHOOK_SECRET", "tooshort-secret-value");
    const text = await (await post()).text();
    expect(text).not.toContain("tooshort-secret-value");
  });
});
