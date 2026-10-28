/**
 * QA (fix/hardening): the CSRF checks on every real route that changes
 * something, in mock mode (the signed-in mock user, so a request that got
 * through WOULD change the mock store). Every refusal must happen before
 * the handler runs: nothing in the store changes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiErrorSchema } from "@/contracts";
import { MOCK_ITEMS } from "@/lib/mocks/fixtures";
import { listItems, listOutfits, resetMockStore } from "@/lib/mocks/store";
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

const BASE = "http://localhost:3000";
const ITEM_ID = MOCK_ITEMS[0]!.id;
const OUTFIT_ID = "1b000000-0000-4000-8000-000000000001";
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

type Handler = (request: Request) => Promise<Response>;

const JPEG = new File([Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0])], "a.jpg", { type: "image/jpeg" });

function multipartBody(fields: Record<string, File | string>): FormData {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return form;
}

/** Every unsafe route, with a body that would be valid. */
const ROUTES: { name: string; method: string; path: string; json?: unknown; form?: () => FormData; call: Handler }[] = [
  { name: "magic-link", method: "POST", path: "/api/auth/magic-link", json: { email: "tester@example.com" }, call: magicLink.POST },
  { name: "verify-code", method: "POST", path: "/api/auth/verify-code", json: { email: "tester@example.com", code: "123456" }, call: verifyCode.POST },
  { name: "sign-out", method: "POST", path: "/api/auth/sign-out", call: signOut.POST },
  {
    name: "create item",
    method: "POST",
    path: "/api/items",
    json: { source: "photo", sourceUrl: null, originalImageKey: "x/y.jpg", cutoutImageKey: null, tags: MOCK_ITEMS[0]!.tags, tagsEdited: false },
    call: items.POST,
  },
  { name: "photo", method: "POST", path: "/api/items/photo", form: () => multipartBody({ original: JPEG }), call: itemPhoto.POST },
  { name: "link step 1", method: "POST", path: "/api/items/link", json: { url: "https://shop.example.com/p/1" }, call: itemLink.POST },
  {
    name: "link step 2",
    method: "POST",
    path: "/api/items/link/cutout",
    form: () => multipartBody({ meta: JSON.stringify({ originalImageKey: "x/y.jpg" }) }),
    call: itemLinkCutout.POST,
  },
  { name: "edit item", method: "PATCH", path: `/api/items/${ITEM_ID}`, json: { tags: MOCK_ITEMS[0]!.tags }, call: (r) => itemById.PATCH(r, ctx(ITEM_ID)) },
  { name: "delete item", method: "DELETE", path: `/api/items/${ITEM_ID}`, call: (r) => itemById.DELETE(r, ctx(ITEM_ID)) },
  { name: "outfits", method: "POST", path: "/api/outfits", json: { style: { kind: "preset", presetId: "work" }, count: 3 }, call: outfits.POST },
  { name: "outfit status", method: "PATCH", path: `/api/outfits/${OUTFIT_ID}`, json: { status: "saved" }, call: (r) => outfitById.PATCH(r, ctx(OUTFIT_ID)) },
  {
    name: "refine",
    method: "POST",
    path: `/api/outfits/${OUTFIT_ID}/refine`,
    json: { kind: "guidance", text: "warmer" },
    call: (r) => refine.POST(r, ctx(OUTFIT_ID)),
  },
  { name: "delete account", method: "DELETE", path: "/api/account", call: account.DELETE },
];

function build(route: (typeof ROUTES)[number], headers: Record<string, string>): Request {
  if (route.json !== undefined) {
    return new Request(`${BASE}${route.path}`, {
      method: route.method,
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(route.json),
    });
  }
  if (route.form) return new Request(`${BASE}${route.path}`, { method: route.method, headers, body: route.form() });
  return new Request(`${BASE}${route.path}`, { method: route.method, headers });
}

/** A fingerprint of everything a request could change in the mock store. */
function snapshot() {
  return JSON.stringify({ items: listItems(), outfits: listOutfits() });
}

const FOREIGN: [string, Record<string, string>][] = [
  ["a foreign Origin", { origin: "https://evil.example" }],
  ['Origin "null" (sandboxed iframe, data: URL)', { origin: "null" }],
  ["no Origin, Sec-Fetch-Site cross-site", { "sec-fetch-site": "cross-site" }],
  ["the right host on another port", { origin: "http://localhost:3001" }],
  ["the right host over https", { origin: "https://localhost:3000" }],
  ["a subdomain of the site", { origin: "http://evil.localhost:3000" }],
  ["the origin with a trailing slash", { origin: "http://localhost:3000/" }],
  ["the origin in upper case", { origin: "HTTP://LOCALHOST:3000" }],
  // Orchestrator decision (fix round): Sec-Fetch-Site: same-origin is set by
  // the browser and can't be forged by a page, so it's trusted even with an
  // Origin that differs from request.url (LAN testing, a proxy). A sibling
  // subdomain (same-site) with a foreign Origin is still refused.
  ["a foreign Origin with same-site fetch metadata", { origin: "https://evil.example", "sec-fetch-site": "same-site" }],
  ["Origin null with same-site fetch metadata", { origin: "null", "sec-fetch-site": "same-site" }],
];

beforeEach(() => {
  vi.stubEnv("GLADRAGS_MOCK_MODE", "true");
  resetMockStore();
  delete (globalThis as { __gladragsMockUsage?: unknown }).__gladragsMockUsage;
  delete (globalThis as { __gladragsMockSignInAttempts?: unknown }).__gladragsMockSignInAttempts;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("every unsafe route refuses cross-site requests before doing anything", () => {
  for (const route of ROUTES) {
    for (const [label, headers] of FOREIGN) {
      it(`${route.method} ${route.name}: ${label} -> 403 forbidden, nothing changed`, async () => {
        const before = snapshot();
        const res = await route.call(build(route, headers));
        expect(res.status).toBe(403);
        expect(ApiErrorSchema.parse(await res.json()).error.code).toBe("forbidden");
        expect(snapshot()).toBe(before);
      });
    }
  }

  it("a forbidden DELETE /api/account leaves the whole mock wardrobe in place", async () => {
    await account.DELETE(build(ROUTES.find((r) => r.name === "delete account")!, { origin: "https://evil.example" }));
    expect(listItems()).toHaveLength(MOCK_ITEMS.length);
  });

  it("a forbidden magic-link request isn't counted against the sign-in limit", async () => {
    const route = ROUTES.find((r) => r.name === "magic-link")!;
    for (let i = 0; i < 10; i++) await route.call(build(route, { origin: "https://evil.example" }));
    const res = await route.call(build(route, { origin: BASE }));
    expect(res.status).toBe(200);
  });
});

describe("requests from this site still work", () => {
  for (const route of ROUTES) {
    it(`${route.method} ${route.name}: same Origin isn't refused as cross-site`, async () => {
      const res = await route.call(build(route, { origin: BASE, "sec-fetch-site": "same-origin" }));
      expect(res.status).not.toBe(403);
      expect(res.status).not.toBe(415);
    });
  }

  it("no Origin with Sec-Fetch-Site same-site passes the check (documented: only cross-site is refused)", async () => {
    const route = ROUTES.find((r) => r.name === "outfits")!;
    const res = await route.call(build(route, { "sec-fetch-site": "same-site" }));
    expect(res.status).toBe(200);
  });

  it("GET with a foreign Origin is allowed (safe methods change nothing)", async () => {
    const res = await usage.GET(new Request(`${BASE}/api/usage`, { headers: { origin: "https://evil.example" } }));
    expect(res.status).toBe(200);
  });

  it("NEXT_PUBLIC_SITE_URL's origin is accepted on every route", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://gladrags.example");
    const route = ROUTES.find((r) => r.name === "outfits")!;
    expect((await route.call(build(route, { origin: "https://gladrags.example" }))).status).toBe(200);
  });
});

describe("Content-Type on the JSON routes", () => {
  const jsonRoutes = ROUTES.filter((r) => r.json !== undefined);
  const raw = (route: (typeof ROUTES)[number], contentType: string | null) =>
    new Request(`${BASE}${route.path}`, {
      method: route.method,
      headers: contentType === null ? { origin: BASE } : { origin: BASE, "content-type": contentType },
      body: JSON.stringify(route.json),
    });

  for (const route of jsonRoutes) {
    for (const type of ["text/plain", "text/plain;charset=UTF-8", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "application/json-patch+json", "application/jsonx", null]) {
      it(`${route.method} ${route.name} with ${type ?? "no Content-Type"}: 415, nothing changed`, async () => {
        const before = snapshot();
        const res = await route.call(raw(route, type));
        expect(res.status).toBe(415);
        expect(ApiErrorSchema.parse(await res.json()).error.code).toBe("unsupported_media_type");
        expect(snapshot()).toBe(before);
      });
    }
    for (const type of ["application/json; charset=utf-8", "Application/JSON", "application/json ;charset=UTF-8"]) {
      it(`${route.method} ${route.name} with ${type}: accepted`, async () => {
        const res = await route.call(raw(route, type));
        expect(res.status).not.toBe(415);
      });
    }
  }

  it("the multipart photo route with its right type works, and with a JSON type is a 400 (not a 500)", async () => {
    const photo = ROUTES.find((r) => r.name === "photo")!;
    expect((await photo.call(build(photo, { origin: BASE }))).status).toBe(200);
    const wrong = await itemPhoto.POST(
      new Request(`${BASE}/api/items/photo`, { method: "POST", headers: { origin: BASE, "content-type": "application/json" }, body: "{}" }),
    );
    expect(wrong.status).toBe(400);
  });

  it("the multipart link step 2 route with text/plain is a 400 (not a 500)", async () => {
    const res = await itemLinkCutout.POST(
      new Request(`${BASE}/api/items/link/cutout`, { method: "POST", headers: { origin: BASE, "content-type": "text/plain" }, body: "meta=x" }),
    );
    expect(res.status).toBe(400);
  });

  it("sign-out posted from this site's own HTML form redirects to /sign-in", async () => {
    const res = await signOut.POST(
      new Request(`${BASE}/api/auth/sign-out`, { method: "POST", headers: { origin: BASE, "content-type": "application/x-www-form-urlencoded" }, body: "" }),
    );
    expect(res.status).toBe(303);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/sign-in");
  });
});
