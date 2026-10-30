/**
 * QA: route stubs in mock mode, beyond the builder's tests. The UI agents
 * build against these, so they must keep the contracts: the AI pause, the
 * daily caps (including refinements and the two-step link flow), the
 * composition rule on every mock outfit, and the "missing category" path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  API_ERROR_STATUS,
  ApiErrorSchema,
  ItemDraftResponseSchema,
  ItemListResponseSchema,
  LinkImportResponseSchema,
  OutfitGenerationResponseSchema,
  OutfitListResponseSchema,
  OutfitResponseSchema,
  UsageSummarySchema,
  VerifyCodeResponseSchema,
  checkComposition,
  type ApiErrorCode,
  type Outfit,
} from "@/contracts";
import { MOCK_ITEMS } from "@/lib/mocks/fixtures";
import { resetMockStore } from "@/lib/mocks/store";
import { DAILY_CAPS, InMemoryUsageStore, MONTHLY_AI_SPEND_CAP_PENCE } from "@/lib/usage";
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
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const globalUsage = globalThis as unknown as { __gladragsMockUsage?: InMemoryUsageStore };

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

async function expectError(response: Response, code: ApiErrorCode) {
  expect(response.status).toBe(API_ERROR_STATUS[code]);
  const body = ApiErrorSchema.parse(await response.json());
  expect(body.error.code).toBe(code);
  return body.error;
}

async function getUsage() {
  return UsageSummarySchema.parse(await (await usage.GET(json("/api/usage", "GET"))).json());
}

async function generate(body: unknown) {
  const res = await outfits.POST(json("/api/outfits", "POST", body));
  expect(res.status).toBe(200);
  return OutfitGenerationResponseSchema.parse(await res.json());
}

function categoriesOf(outfit: Outfit) {
  return outfit.items.map((i) => i.tags.category);
}

beforeEach(() => {
  vi.stubEnv("GLADRAGS_MOCK_MODE", "true");
  resetMockStore();
  globalUsage.__gladragsMockUsage = new InMemoryUsageStore();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("monthly AI pause stops AI routes but not browsing", () => {
  let outfitId: string;

  beforeEach(async () => {
    const body = await generate({ style: { kind: "preset", presetId: "work" }, count: 3 });
    if (body.status !== "ok") throw new Error("expected outfits");
    outfitId = body.outfits[0]!.id;
    await outfitById.PATCH(json(`/api/outfits/${outfitId}`, "PATCH", { status: "saved" }), ctx(outfitId));
    await globalUsage.__gladragsMockUsage!.record({ userId: null, kind: "ranking_final", costPence: MONTHLY_AI_SPEND_CAP_PENCE, provider: "fake" });
  });

  it.each([
    ["POST /api/items/photo", () => itemPhoto.POST(multipart("/api/items/photo", { original: jpeg() }))],
    ["POST /api/items/link", () => itemLink.POST(json("/api/items/link", "POST", { url: "https://shop.example.com/p/1" }))],
    ["POST /api/outfits", () => outfits.POST(json("/api/outfits", "POST", { style: { kind: "preset", presetId: "casual" } }))],
  ] as [string, () => Promise<Response>][])("%s returns 503 ai_paused with the reset time", async (_label, call) => {
    const error = await expectError(await call(), "ai_paused");
    expect(error.cap?.kind).toBe("monthly_ai_spend");
    expect(error.cap?.limit).toBe(MONTHLY_AI_SPEND_CAP_PENCE);
    expect(new Date(error.cap!.resetsAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("POST /api/outfits/[id]/refine returns 503 ai_paused", async () => {
    const res = await refine.POST(json(`/api/outfits/${outfitId}/refine`, "POST", { kind: "guidance", text: "warmer" }), ctx(outfitId));
    await expectError(res, "ai_paused");
  });

  it("POST /api/items/link/cutout (step 2, tagging) returns 503 ai_paused", async () => {
    globalUsage.__gladragsMockUsage = new InMemoryUsageStore();
    const one = LinkImportResponseSchema.parse(
      await (await itemLink.POST(json("/api/items/link", "POST", { url: "https://shop.example.com/p/1" }))).json(),
    );
    if (one.status !== "ok") throw new Error("expected ok");
    await globalUsage.__gladragsMockUsage.record({ userId: null, kind: "tagging", costPence: MONTHLY_AI_SPEND_CAP_PENCE, provider: "fake" });
    const meta = { sourceUrl: one.sourceUrl, originalImageKey: one.originalImageKey, product: one.product };
    await expectError(await itemLinkCutout.POST(multipart("/api/items/link/cutout", { meta: JSON.stringify(meta), cutout: png() })), "ai_paused");
  });

  it("doesn't count a refused request against the daily cap", async () => {
    await itemPhoto.POST(multipart("/api/items/photo", { original: jpeg() }));
    expect((await getUsage()).itemsToday.used).toBe(0);
  });

  it("still lists the wardrobe and saved outfits, edits tags, and reports aiPaused", async () => {
    expect((await items.GET(json("/api/items", "GET"))).status).toBe(200);
    const saved = OutfitListResponseSchema.parse(await (await outfits.GET(json("/api/outfits?status=saved", "GET"))).json());
    expect(saved.outfits.map((o) => o.id)).toEqual([outfitId]);
    const item = MOCK_ITEMS[0]!;
    expect((await itemById.PATCH(json(`/api/items/${item.id}`, "PATCH", { tags: item.tags }), ctx(item.id))).status).toBe(200);
    expect((await outfitById.PATCH(json(`/api/outfits/${outfitId}`, "PATCH", { status: "liked" }), ctx(outfitId))).status).toBe(200);
    expect((await getUsage()).aiPaused).toBe(true);
  });
});

describe("daily outfit cap includes refinements", () => {
  it("allows 25 requests and refinements together, then 429s both", async () => {
    const first = await generate({ style: { kind: "preset", presetId: "work" }, count: 3 });
    if (first.status !== "ok") throw new Error("expected outfits");
    const id = first.outfits[0]!.id;
    for (let i = 1; i < DAILY_CAPS.outfit_request; i++) {
      const res =
        i % 2
          ? await refine.POST(json(`/api/outfits/${id}/refine`, "POST", { kind: "guidance", text: "warmer" }), ctx(id))
          : await outfits.POST(json("/api/outfits", "POST", { style: { kind: "preset", presetId: "casual" } }));
      expect(res.status, `request ${i + 1}`).toBe(200);
    }
    expect((await getUsage()).outfitRequestsToday).toEqual({ used: 25, limit: 25 });
    const a = await expectError(await outfits.POST(json("/api/outfits", "POST", { style: { kind: "preset", presetId: "casual" } })), "daily_cap_reached");
    expect(a.cap?.kind).toBe("outfit_requests_per_day");
    await expectError(
      await refine.POST(json(`/api/outfits/${id}/refine`, "POST", { kind: "guidance", text: "warmer" }), ctx(id)),
      "daily_cap_reached",
    );
  });

  it("doesn't count invalid requests or unknown anchors", async () => {
    await outfits.POST(json("/api/outfits", "POST", { style: { kind: "preset", presetId: "work" }, count: 9 }));
    await outfits.POST(json("/api/outfits", "POST", { style: { kind: "preset", presetId: "work" }, anchorItemId: "9f000000-0000-4000-8000-000000000000" }));
    expect((await getUsage()).outfitRequestsToday.used).toBe(0);
  });
});

describe("add by link counts once against the item cap", () => {
  it("ok link + cut-out step counts 1", async () => {
    const one = LinkImportResponseSchema.parse(
      await (await itemLink.POST(json("/api/items/link", "POST", { url: "https://shop.example.com/p/1" }))).json(),
    );
    if (one.status !== "ok") throw new Error("expected ok");
    const meta = { sourceUrl: one.sourceUrl, originalImageKey: one.originalImageKey, product: one.product };
    expect((await itemLinkCutout.POST(multipart("/api/items/link/cutout", { meta: JSON.stringify(meta) }))).status).toBe(200);
    expect((await getUsage()).itemsToday.used).toBe(1);
  });

  it("blocked link + screenshot through add-by-photo counts 1, and the draft keeps the link", async () => {
    const url = "https://blocked.example.com/p/1";
    const one = LinkImportResponseSchema.parse(await (await itemLink.POST(json("/api/items/link", "POST", { url }))).json());
    expect(one).toMatchObject({ status: "needs_screenshot", reason: "fetch_blocked" });
    if (one.status !== "needs_screenshot") return;
    expect(one.message.length).toBeGreaterThan(0);
    const shot = await itemPhoto.POST(multipart("/api/items/photo", { original: png(), sourceUrl: one.sourceUrl }));
    const { draft } = ItemDraftResponseSchema.parse(await shot.json());
    expect(draft).toMatchObject({ source: "link", sourceUrl: url });
    expect((await getUsage()).itemsToday.used).toBe(1);
  });

  it("refuses step 1 at the cap even for a link that would need a screenshot", async () => {
    for (let i = 0; i < DAILY_CAPS.item_ingest; i++) await globalUsage.__gladragsMockUsage!.record({ userId: "0a000000-0000-4000-8000-000000000001", kind: "item_ingest", costPence: 0, provider: null });
    await expectError(await itemLink.POST(json("/api/items/link", "POST", { url: "https://nodata.example.com/p" })), "daily_cap_reached");
  });

  it("matches the mock markers on the host only, not the path", async () => {
    const body = LinkImportResponseSchema.parse(
      await (await itemLink.POST(json("/api/items/link", "POST", { url: "https://shop.example.com/blocked/noimage" }))).json(),
    );
    expect(body.status).toBe("ok");
  });
});

describe("mock outfits obey the composition rule", () => {
  it.each([3, 4, 5])("returns exactly %i wearable outfits with items matching itemIds", async (count) => {
    const body = await generate({ style: { kind: "preset", presetId: "smart_casual" }, count });
    expect(body.status).toBe("ok");
    if (body.status !== "ok") return;
    expect(body.outfits).toHaveLength(count);
    for (const o of body.outfits) {
      expect(checkComposition(categoriesOf(o))).toEqual({ ok: true });
      expect(o.items.map((i) => i.id)).toEqual(o.itemIds);
      expect(o.status).toBe("suggested");
      expect(o.parentOutfitId).toBeNull();
    }
  });

  it.each(["top", "bottom", "shoes", "outerwear", "dress_jumpsuit"] as const)("includes a %s anchor in every outfit", async (category) => {
    const anchor = MOCK_ITEMS.find((i) => i.tags.category === category)!;
    const body = await generate({ style: { kind: "preset", presetId: "casual" }, anchorItemId: anchor.id, count: 5 });
    expect(body.status).toBe("ok");
    if (body.status !== "ok") return;
    for (const o of body.outfits) {
      expect(o.itemIds).toContain(anchor.id);
      expect(checkComposition(categoriesOf(o))).toEqual({ ok: true });
      expect(o.request.anchorItemId).toBe(anchor.id);
    }
  });

  it("keeps the guidance and custom style on the stored request", async () => {
    const body = await generate({ style: { kind: "custom", text: "garden party" }, guidance: "no heels" });
    if (body.status !== "ok") throw new Error("expected outfits");
    expect(body.outfits[0]!.request).toEqual({
      style: { kind: "custom", text: "garden party" },
      guidance: "no heels",
      anchorItemId: null,
      includeShopItems: false,
    });
  });

  it("refined outfits are wearable, linked to the parent, and leave out the swapped item", async () => {
    const body = await generate({ style: { kind: "preset", presetId: "work" } });
    if (body.status !== "ok") throw new Error("expected outfits");
    const parent = body.outfits[0]!;
    for (const swapped of parent.itemIds) {
      const res = await refine.POST(json(`/api/outfits/${parent.id}/refine`, "POST", { kind: "swap", itemId: swapped }), ctx(parent.id));
      const revised = OutfitGenerationResponseSchema.parse(await res.json());
      expect(revised.status).toBe("ok");
      if (revised.status !== "ok") continue;
      for (const o of revised.outfits) {
        expect(o.itemIds).not.toContain(swapped);
        expect(o.parentOutfitId).toBe(parent.id);
        expect(checkComposition(categoriesOf(o))).toEqual({ ok: true });
      }
    }
  });
});

describe("missing category message", () => {
  async function deleteCategory(category: string) {
    for (const item of MOCK_ITEMS.filter((i) => i.tags.category === category)) {
      await itemById.DELETE(json(`/api/items/${item.id}`, "DELETE"), ctx(item.id));
    }
  }

  it("asks for a top when there are bottoms and shoes but no tops or dresses", async () => {
    await deleteCategory("top");
    await deleteCategory("dress_jumpsuit");
    const body = await generate({ style: { kind: "preset", presetId: "casual" } });
    expect(body).toMatchObject({ status: "incomplete_wardrobe", reason: "missing_category", missingCategories: ["top"] });
    if (body.status === "incomplete_wardrobe") expect(body.message).toMatch(/top/);
  });

  it("asks for top, bottom and shoes for an empty wardrobe", async () => {
    for (const item of MOCK_ITEMS) await itemById.DELETE(json(`/api/items/${item.id}`, "DELETE"), ctx(item.id));
    expect((await items.GET(json("/api/items", "GET"))).status).toBe(200);
    const body = await generate({ style: { kind: "preset", presetId: "casual" } });
    expect(body).toMatchObject({ status: "incomplete_wardrobe", missingCategories: ["top", "bottom", "shoes"] });
  });

  it("swapping out the only pair of shoes says shoes are missing", async () => {
    const shoes = MOCK_ITEMS.filter((i) => i.tags.category === "shoes");
    for (const s of shoes.slice(1)) await itemById.DELETE(json(`/api/items/${s.id}`, "DELETE"), ctx(s.id));
    const body = await generate({ style: { kind: "preset", presetId: "casual" }, count: 3 });
    if (body.status !== "ok") throw new Error("expected outfits");
    const parent = body.outfits[0]!;
    const res = await refine.POST(json(`/api/outfits/${parent.id}/refine`, "POST", { kind: "swap", itemId: shoes[0]!.id }), ctx(parent.id));
    expect(OutfitGenerationResponseSchema.parse(await res.json())).toMatchObject({
      status: "incomplete_wardrobe",
      missingCategories: ["shoes"],
    });
  });
});

describe("save, like and reject", () => {
  let ids: string[];

  beforeEach(async () => {
    const body = await generate({ style: { kind: "preset", presetId: "casual" }, count: 3 });
    if (body.status !== "ok") throw new Error("expected outfits");
    ids = body.outfits.map((o) => o.id);
  });

  it("sets each status and lists by status", async () => {
    const [a, b, c] = ids as [string, string, string];
    await outfitById.PATCH(json(`/api/outfits/${a}`, "PATCH", { status: "saved" }), ctx(a));
    await outfitById.PATCH(json(`/api/outfits/${b}`, "PATCH", { status: "liked" }), ctx(b));
    const rejected = await outfitById.PATCH(json(`/api/outfits/${c}`, "PATCH", { status: "rejected", reason: "too formal" }), ctx(c));
    expect(OutfitResponseSchema.parse(await rejected.json()).outfit.status).toBe("rejected");
    const list = async (status: string) =>
      OutfitListResponseSchema.parse(await (await outfits.GET(json(`/api/outfits?status=${status}`, "GET"))).json()).outfits.map((o) => o.id);
    expect(await list("saved")).toEqual([a]);
    expect(await list("liked")).toEqual([b]);
    expect(await list("rejected")).toEqual([c]);
    expect(await list("suggested")).toEqual([]);
  });

  it("rejects a multi-line or over-long reason, and an unknown status filter", async () => {
    const id = ids[0]!;
    await expectError(await outfitById.PATCH(json(`/api/outfits/${id}`, "PATCH", { status: "rejected", reason: "x\ny" }), ctx(id)), "bad_request");
    await expectError(await outfitById.PATCH(json(`/api/outfits/${id}`, "PATCH", { status: "rejected", reason: "x".repeat(201) }), ctx(id)), "bad_request");
    await expectError(await outfits.GET(json("/api/outfits?status=loved", "GET")), "bad_request");
  });

  it("returns 404 for an unknown outfit", async () => {
    const missing = "2f000000-0000-4000-8000-000000000000";
    await expectError(await outfitById.PATCH(json(`/api/outfits/${missing}`, "PATCH", { status: "saved" }), ctx(missing)), "not_found");
    await expectError(await refine.POST(json(`/api/outfits/${missing}/refine`, "POST", { kind: "guidance", text: "x" }), ctx(missing)), "not_found");
  });

  it("deleting an item removes the outfits that used it, saved ones included", async () => {
    const id = ids[0]!;
    await outfitById.PATCH(json(`/api/outfits/${id}`, "PATCH", { status: "saved" }), ctx(id));
    const outfit = OutfitResponseSchema.parse(await (await outfitById.GET(json(`/api/outfits/${id}`, "GET"), ctx(id))).json()).outfit;
    await itemById.DELETE(json("/x", "DELETE"), ctx(outfit.itemIds[0]!));
    await expectError(await outfitById.GET(json(`/api/outfits/${id}`, "GET"), ctx(id)), "not_found");
  });
});

describe("items: filters and edits", () => {
  it("combines filters with AND", async () => {
    const res = await items.GET(json("/api/items?category=top&colour=grey&occasion=casual", "GET"));
    const body = ItemListResponseSchema.parse(await res.json());
    expect(body.items.map((i) => i.tags.description)).toEqual(["Grey merino crew jumper"]);
  });

  it("rejects an over-long search and returns an empty list for no matches", async () => {
    await expectError(await items.GET(json(`/api/items?q=${"x".repeat(101)}`, "GET")), "bad_request");
    const body = ItemListResponseSchema.parse(await (await items.GET(json("/api/items?q=zzzz", "GET"))).json());
    expect(body.items).toEqual([]);
  });

  it("refuses a PATCH with partial tags (the edit form must send all of them)", async () => {
    const id = MOCK_ITEMS[0]!.id;
    await expectError(await itemById.PATCH(json(`/api/items/${id}`, "PATCH", { tags: { description: "New" } }), ctx(id)), "bad_request");
  });

  it("refuses a PATCH that moves an item to a category its subcategory doesn't belong to", async () => {
    const item = MOCK_ITEMS[0]!;
    const res = await itemById.PATCH(json(`/api/items/${item.id}`, "PATCH", { tags: { ...item.tags, category: "shoes" } }), ctx(item.id));
    const error = await expectError(res, "bad_request");
    expect(error.issues?.map((i) => i.path)).toContain("tags.subcategory");
  });
});

describe("mock sign-in", () => {
  it("accepts any 6-digit code and echoes a safe next", async () => {
    const res = await verifyCode.POST(json("/api/auth/verify-code", "POST", { email: "a@example.com", code: "000000", next: "/outfits" }));
    expect(VerifyCodeResponseSchema.parse(await res.json())).toEqual({ signedIn: true, next: "/outfits" });
  });

  it("still refuses an off-site next in mock mode", async () => {
    const res = await verifyCode.POST(json("/api/auth/verify-code", "POST", { email: "a@example.com", code: "000000", next: "//evil.example.com" }));
    await expectError(res, "bad_request");
  });
});
