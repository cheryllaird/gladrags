/**
 * The milestone 5 route stubs, called directly in mock mode (and once with
 * mock mode off, where they must refuse rather than serve mock data).
 * Checks they validate input with the contracts and answer with them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiErrorSchema,
  BatchAddResponseSchema,
  EmailImportListResponseSchema,
  ItemListResponseSchema,
  ItemResponseSchema,
  MarkItemsReviewedResponseSchema,
  OutfitGenerationResponseSchema,
  OutfitResponseSchema,
  UsageSummarySchema,
  UserSettingsSchema,
  type Outfit,
} from "@/contracts";
import { MOCK_USER } from "@/lib/auth/session";
import { MOCK_FORWARDING_TOKEN, MOCK_ITEMS } from "@/lib/mocks/fixtures";
import { resetMockStore } from "@/lib/mocks/store";
import * as emailImports from "./email-imports/route";
import * as inboundEmail from "./inbound/email/route";
import * as itemCutout from "./items/[id]/cutout/route";
import * as itemPhotoReplace from "./items/[id]/photo/route";
import * as itemById from "./items/[id]/route";
import * as itemLinkCutout from "./items/link/cutout/route";
import * as itemLink from "./items/link/route";
import * as itemPhoto from "./items/photo/route";
import * as itemsReviewed from "./items/reviewed/route";
import * as items from "./items/route";
import * as gapProduct from "./outfits/[id]/gaps/[category]/route";
import * as shopSearch from "./outfits/[id]/shop-search/route";
import * as outfits from "./outfits/route";
import * as forwardingAddress from "./settings/forwarding-address/route";
import * as settings from "./settings/route";
import * as usage from "./usage/route";

const BASE = "http://localhost:3000";
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

function json(path: string, method: string, body?: unknown): Request {
  return new Request(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const get = (path: string) => new Request(`${BASE}${path}`);

function form(path: string, method: string, fields: Record<string, string | File>): Request {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return new Request(`${BASE}${path}`, { method, body: data });
}

const JPEG_MAGIC = [0xff, 0xd8, 0xff, 0xe0];
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
function fileOf(magic: number[], name: string, type: string): File {
  const bytes = new Uint8Array(1024);
  bytes.set(magic);
  return new File([bytes], name, { type });
}
const jpeg = (name = "photo.jpg") => fileOf(JPEG_MAGIC, name, "image/jpeg");
const png = () => fileOf(PNG_MAGIC, "cutout.png", "image/png");

async function expectError(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(ApiErrorSchema.parse(await response.json()).error.code).toBe(code);
}

async function gapOutfits(): Promise<Outfit[]> {
  const res = await outfits.POST(json("/api/outfits", "POST", { style: { kind: "preset", presetId: "casual" }, includeShopItems: true }));
  const body = OutfitGenerationResponseSchema.parse(await res.json());
  if (body.status !== "ok") throw new Error("expected outfits");
  return body.outfits;
}

function inbound(overrides: Record<string, unknown> = {}): Request {
  return new Request(`${BASE}/api/inbound/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      messageId: "<order-1@mail.example>",
      from: MOCK_USER.email,
      to: [`${MOCK_FORWARDING_TOKEN}@inbound.gladrags.test`],
      subject: "Fwd: Your M&S order",
      text: "Thanks for your order",
      html: null,
      receivedAt: "2026-10-30T10:00:00.000Z",
      auth: { spf: "pass", dkim: "pass", dmarc: "pass" },
      spam: { isSpam: false, score: 0 },
      ...overrides,
    }),
  });
}

beforeEach(() => {
  vi.stubEnv("GLADRAGS_MOCK_MODE", "true");
  vi.stubEnv("INBOUND_EMAIL_DOMAIN", "");
  resetMockStore();
  delete (globalThis as { __gladragsMockUsage?: unknown }).__gladragsMockUsage;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("reviewing new items", () => {
  it("a batch photo add saves the item as to review, and the review filter finds it", async () => {
    const res = await itemPhoto.POST(form("/api/items/photo", "POST", { original: jpeg(), saveForReview: "true" }));
    expect(res.status).toBe(200);
    const body = BatchAddResponseSchema.parse(await res.json());
    if (body.status !== "saved") throw new Error("expected a saved item");
    expect(body.item.needsReview).toBe(true);
    expect(body.item.cutoutUrl).toBeNull();

    const list = ItemListResponseSchema.parse(await (await items.GET(new Request(`${BASE}/api/items?needsReview=true`))).json());
    expect(list.items.map((i) => i.id)).toEqual([body.item.id]);

    const confirmed = await itemById.PATCH(json(`/api/items/${body.item.id}`, "PATCH", { reviewed: true }), ctx(body.item.id));
    const item = ItemResponseSchema.parse(await confirmed.json()).item;
    expect(item).toMatchObject({ needsReview: false, tagsEdited: false });
  });

  it("a batch add whose tagging failed comes back as a draft", async () => {
    const res = await itemPhoto.POST(form("/api/items/photo", "POST", { original: jpeg("shirt-mock-no-tags.jpg"), saveForReview: "true" }));
    const body = BatchAddResponseSchema.parse(await res.json());
    expect(body).toMatchObject({ status: "draft", draft: { suggestedTags: null } });
  });

  it("a single photo add still returns a draft, as before", async () => {
    const res = await itemPhoto.POST(form("/api/items/photo", "POST", { original: jpeg() }));
    const body = await res.json();
    expect(body.draft.cutoutImageKey).toBeNull();
  });

  it("a batch link add saves as to review without a cut-out", async () => {
    const step1 = await (await itemLink.POST(json("/api/items/link", "POST", { url: "https://shop.example.com/p/1" }))).json();
    const res = await itemLinkCutout.POST(
      form("/api/items/link/cutout", "POST", { meta: JSON.stringify({ originalImageKey: step1.originalImageKey, saveForReview: true }) }),
    );
    const body = BatchAddResponseSchema.parse(await res.json());
    expect(body).toMatchObject({ status: "saved", item: { source: "link", needsReview: true, cutoutUrl: null } });
  });

  it("Confirm all marks several reviewed, ignoring unknown IDs", async () => {
    const saved = [];
    for (let i = 0; i < 2; i++) {
      const res = await itemPhoto.POST(form("/api/items/photo", "POST", { original: jpeg(), saveForReview: "true" }));
      saved.push(BatchAddResponseSchema.parse(await res.json()));
    }
    const ids = saved.map((s) => (s.status === "saved" ? s.item.id : ""));
    const res = await itemsReviewed.POST(json("/api/items/reviewed", "POST", { itemIds: [...ids, "1a000000-0000-4000-8000-0000000009ff"] }));
    expect(MarkItemsReviewedResponseSchema.parse(await res.json())).toEqual({ updated: 2 });
    await expectError(await itemsReviewed.POST(json("/api/items/reviewed", "POST", { itemIds: [] })), 400, "bad_request");
  });

  it("an empty PATCH is refused", async () => {
    await expectError(await itemById.PATCH(json(`/api/items/${MOCK_ITEMS[0]!.id}`, "PATCH", {}), ctx(MOCK_ITEMS[0]!.id)), 400, "bad_request");
  });
});

describe("item images after adding", () => {
  it("stores a cut-out for an existing item", async () => {
    const coat = MOCK_ITEMS[8]!;
    const res = await itemCutout.PUT(form(`/api/items/${coat.id}/cutout`, "PUT", { cutout: png() }), ctx(coat.id));
    expect(ItemResponseSchema.parse(await res.json()).item.cutoutUrl).not.toBeNull();
  });

  it("refuses a cut-out that isn't a PNG, or is missing", async () => {
    const coat = MOCK_ITEMS[8]!;
    await expectError(await itemCutout.PUT(form(`/api/items/${coat.id}/cutout`, "PUT", { cutout: jpeg() }), ctx(coat.id)), 400, "bad_request");
    await expectError(await itemCutout.PUT(form(`/api/items/${coat.id}/cutout`, "PUT", {}), ctx(coat.id)), 400, "bad_request");
  });

  it("not_found for someone else's or a missing item", async () => {
    const id = "1a000000-0000-4000-8000-0000000009ff";
    await expectError(await itemCutout.PUT(form(`/api/items/${id}/cutout`, "PUT", { cutout: png() }), ctx(id)), 404, "not_found");
  });

  it("adds a photo to an email item that had none", async () => {
    await inboundEmail.POST(inbound());
    const list = ItemListResponseSchema.parse(await (await items.GET(new Request(`${BASE}/api/items?needsReview=true`))).json());
    const noPhoto = list.items.find((i) => i.needsPhoto)!;
    expect(noPhoto.originalUrl).toBe("/mock/items/no-picture.svg");
    const res = await itemPhotoReplace.PUT(form(`/api/items/${noPhoto.id}/photo`, "PUT", { original: jpeg() }), ctx(noPhoto.id));
    expect(ItemResponseSchema.parse(await res.json()).item).toMatchObject({ needsPhoto: false, needsReview: true });
  });
});

describe("outfits with gaps and shop search", () => {
  it("includeShopItems gives outfits with a shop-item gap and nothing missing", async () => {
    const res = await outfits.POST(json("/api/outfits", "POST", { style: { kind: "preset", presetId: "casual" }, includeShopItems: true }));
    const body = OutfitGenerationResponseSchema.parse(await res.json());
    expect(body).toMatchObject({ status: "ok", missingCategories: [] });
    if (body.status !== "ok") return;
    for (const outfit of body.outfits) {
      expect(outfit.gaps.map((g) => g.category)).toEqual(["shoes"]);
      expect(outfit.request.includeShopItems).toBe(true);
    }
  });

  it("the mock-gaps marker does the same; a normal request still has no gaps", async () => {
    const marked = OutfitGenerationResponseSchema.parse(
      await (await outfits.POST(json("/api/outfits", "POST", { style: { kind: "preset", presetId: "casual" }, guidance: "mock-gaps" }))).json(),
    );
    expect(marked.status === "ok" && marked.outfits.every((o) => o.gaps.length === 1)).toBe(true);
    const plain = OutfitGenerationResponseSchema.parse(
      await (await outfits.POST(json("/api/outfits", "POST", { style: { kind: "preset", presetId: "casual" } }))).json(),
    );
    expect(plain.status === "ok" && plain.outfits.every((o) => o.gaps.length === 0)).toBe(true);
  });

  it("Find in my shops fills each gap with up to three products from the favourite shops", async () => {
    const [outfit] = await gapOutfits();
    const res = await shopSearch.POST(json(`/api/outfits/${outfit!.id}/shop-search`, "POST"), ctx(outfit!.id));
    const found = OutfitResponseSchema.parse(await res.json()).outfit;
    const results = found.gaps[0]!.shopResults;
    expect(results).toHaveLength(3);
    expect(new Set(results.map((p) => p.shopId))).toEqual(new Set(["next", "marks_and_spencer", "new_look"]));
    expect(found.gaps[0]!.searchedAt).not.toBeNull();

    const usageNow = UsageSummarySchema.parse(await (await usage.GET(get("/api/usage"))).json());
    expect(usageNow.shopSearchesToday.used).toBe(1);
  });

  it("picks one of the results for a gap, refuses anything else, and can clear it", async () => {
    const [outfit] = await gapOutfits();
    const found = OutfitResponseSchema.parse(await (await shopSearch.POST(json("/x", "POST"), ctx(outfit!.id))).json()).outfit;
    const product = found.gaps[0]!.shopResults[1]!;
    const gapCtx = { params: Promise.resolve({ id: outfit!.id, category: "shoes" }) };

    const chosen = OutfitResponseSchema.parse(await (await gapProduct.PUT(json("/x", "PUT", { productUrl: product.url }), gapCtx)).json());
    expect(chosen.outfit.gaps[0]!.shopProduct).toEqual(product);

    await expectError(await gapProduct.PUT(json("/x", "PUT", { productUrl: "https://www.next.co.uk/made-up" }), gapCtx), 400, "bad_request");
    await expectError(
      await gapProduct.PUT(json("/x", "PUT", { productUrl: null }), { params: Promise.resolve({ id: outfit!.id, category: "outerwear" }) }),
      404,
      "not_found",
    );
    const cleared = OutfitResponseSchema.parse(await (await gapProduct.PUT(json("/x", "PUT", { productUrl: null }), gapCtx)).json());
    expect(cleared.outfit.gaps[0]!.shopProduct).toBeNull();
  });

  it("refuses a shop search on an outfit without gaps", async () => {
    const plain = OutfitGenerationResponseSchema.parse(
      await (await outfits.POST(json("/api/outfits", "POST", { style: { kind: "preset", presetId: "casual" } }))).json(),
    );
    if (plain.status !== "ok") throw new Error("expected outfits");
    const id = plain.outfits[0]!.id;
    await expectError(await shopSearch.POST(json("/x", "POST"), ctx(id)), 400, "bad_request");
  });
});

describe("settings", () => {
  it("shows the default shops and the forwarding address, and changes the shops", async () => {
    const before = UserSettingsSchema.parse(await (await settings.GET(get("/api/settings"))).json());
    expect(before).toEqual({
      favouriteShopIds: ["next", "marks_and_spencer", "new_look"],
      forwardingAddress: `${MOCK_FORWARDING_TOKEN}@inbound.gladrags.test`,
    });
    const after = UserSettingsSchema.parse(await (await settings.PUT(json("/api/settings", "PUT", { favouriteShopIds: ["zara", "uniqlo"] }))).json());
    expect(after.favouriteShopIds).toEqual(["zara", "uniqlo"]);
    await expectError(await settings.PUT(json("/api/settings", "PUT", { favouriteShopIds: ["primark"] })), 400, "bad_request");
  });

  it("uses INBOUND_EMAIL_DOMAIN and INBOUND_EMAIL_PREFIX for the address", async () => {
    vi.stubEnv("INBOUND_EMAIL_DOMAIN", "inbound.postmarkapp.com");
    vi.stubEnv("INBOUND_EMAIL_PREFIX", "abc123+");
    const body = UserSettingsSchema.parse(await (await settings.GET(get("/api/settings"))).json());
    expect(body.forwardingAddress).toBe(`abc123+${MOCK_FORWARDING_TOKEN}@inbound.postmarkapp.com`);
  });

  it("resetting the address gives a new one, and the old one stops working", async () => {
    const reset = UserSettingsSchema.parse(await (await forwardingAddress.POST(json("/x", "POST"))).json());
    expect(reset.forwardingAddress).not.toContain(MOCK_FORWARDING_TOKEN);
    await inboundEmail.POST(inbound());
    const list = EmailImportListResponseSchema.parse(await (await emailImports.GET(get("/api/email-imports"))).json());
    expect(list.imports).toEqual([]);
  });
});

describe("order email webhook (mock)", () => {
  it("an accepted email adds its items to review and records the import", async () => {
    const res = await inboundEmail.POST(inbound());
    expect(await res.json()).toEqual({ received: true });
    const list = EmailImportListResponseSchema.parse(await (await emailImports.GET(get("/api/email-imports"))).json());
    expect(list.imports).toHaveLength(1);
    expect(list.imports[0]).toMatchObject({ status: "done", itemCount: 2, shopName: "M&S" });
    const review = ItemListResponseSchema.parse(await (await items.GET(new Request(`${BASE}/api/items?needsReview=true`))).json());
    expect(review.items.map((i) => i.source)).toEqual(["email", "email"]);
    expect(UsageSummarySchema.parse(await (await usage.GET(get("/api/usage"))).json()).emailsToday.used).toBe(1);
  });

  it("an email from another address, or failing checks, is recorded as failed and adds nothing", async () => {
    await inboundEmail.POST(inbound({ messageId: "<a@mail.example>", from: "stranger@example.com" }));
    await inboundEmail.POST(inbound({ messageId: "<b@mail.example>", auth: { spf: "fail", dkim: "fail", dmarc: "fail" } }));
    const list = EmailImportListResponseSchema.parse(await (await emailImports.GET(get("/api/email-imports"))).json());
    expect(list.imports.map((i) => i.error)).toEqual(["failed_checks", "sender_not_allowed"]);
    const review = ItemListResponseSchema.parse(await (await items.GET(new Request(`${BASE}/api/items?needsReview=true`))).json());
    expect(review.items).toEqual([]);
  });

  it("a redelivered email is handled once", async () => {
    await inboundEmail.POST(inbound());
    expect(await (await inboundEmail.POST(inbound())).json()).toEqual({ received: true });
    expect(EmailImportListResponseSchema.parse(await (await emailImports.GET(get("/api/email-imports"))).json()).imports).toHaveLength(1);
  });

  it("refuses a body over the limit, by Content-Length or by what arrives", async () => {
    const big = "x".repeat(2 * 1024 * 1024 + 1);
    const declared = new Request(`${BASE}/api/inbound/email`, { method: "POST", headers: { "content-length": String(big.length) }, body: "{}" });
    await expectError(await inboundEmail.POST(declared), 400, "bad_request");
    const streamed = new Request(`${BASE}/api/inbound/email`, { method: "POST", body: big });
    await expectError(await inboundEmail.POST(streamed), 400, "bad_request");
  });

  it("an email to an unknown address is answered but ignored; a malformed body is refused", async () => {
    const res = await inboundEmail.POST(inbound({ to: ["ffffffffffffffffffffffffffffffff@inbound.gladrags.test"] }));
    expect(await res.json()).toEqual({ received: true });
    expect(EmailImportListResponseSchema.parse(await (await emailImports.GET(get("/api/email-imports"))).json()).imports).toEqual([]);
    await expectError(await inboundEmail.POST(inbound({ from: "not an address" })), 400, "bad_request");
  });
});

describe("outside mock mode", () => {
  beforeEach(() => {
    vi.stubEnv("GLADRAGS_MOCK_MODE", "false");
  });

  it("the inbound webhook refuses to run without its secret and provider, then refuses an unsigned post", async () => {
    vi.stubEnv("INBOUND_EMAIL_PROVIDER", "postmark");
    vi.stubEnv("INBOUND_EMAIL_WEBHOOK_SECRET", "");
    await expectError(await inboundEmail.POST(inbound()), 500, "server_misconfigured");
    vi.stubEnv("INBOUND_EMAIL_WEBHOOK_SECRET", "x".repeat(32));
    vi.stubEnv("INBOUND_EMAIL_PROVIDER", "");
    await expectError(await inboundEmail.POST(inbound()), 500, "server_misconfigured");
    vi.stubEnv("INBOUND_EMAIL_PROVIDER", "postmark");
    await expectError(await inboundEmail.POST(inbound()), 401, "unauthorized");
  });
});
