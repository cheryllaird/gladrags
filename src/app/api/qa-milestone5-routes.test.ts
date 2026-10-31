/**
 * QA: the milestone 5 route stubs in mock mode, beyond the builder's
 * milestone5-routes.test.ts. The UI agents (C5, C6) build against these,
 * so they must keep the contracts: caps, the webhook's acceptance rule and
 * address matching, shop results only on favourite shops, product choice
 * only from results, and input validation.
 *
 * `it.fails` marks a known bug reported to the orchestrator.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  API_ERROR_STATUS,
  ApiErrorSchema,
  BatchAddResponseSchema,
  EmailImportListResponseSchema,
  INBOUND_WEBHOOK_MAX_BYTES,
  ItemListResponseSchema,
  ItemResponseSchema,
  OutfitGenerationResponseSchema,
  OutfitResponseSchema,
  ShopProductSchema,
  UsageSummarySchema,
  UserSettingsSchema,
  shopForUrl,
  type ApiErrorCode,
  type Outfit,
} from "@/contracts";
import { MOCK_USER } from "@/lib/auth/session";
import { MOCK_FORWARDING_TOKEN, MOCK_ITEMS } from "@/lib/mocks/fixtures";
import { resetMockStore } from "@/lib/mocks/store";
import { DAILY_CAPS } from "@/lib/usage";
import * as emailImports from "./email-imports/route";
import * as inboundEmail from "./inbound/email/route";
import * as itemCutout from "./items/[id]/cutout/route";
import * as itemPhotoReplace from "./items/[id]/photo/route";
import * as itemById from "./items/[id]/route";
import * as itemPhoto from "./items/photo/route";
import * as itemsReviewed from "./items/reviewed/route";
import * as items from "./items/route";
import * as gapProduct from "./outfits/[id]/gaps/[category]/route";
import * as shopSearch from "./outfits/[id]/shop-search/route";
import * as outfits from "./outfits/route";
import * as forwardingAddressRoute from "./settings/forwarding-address/route";
import * as settings from "./settings/route";
import * as usage from "./usage/route";

const BASE = "http://localhost:3000";
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const gapCtx = (id: string, category: string) => ({ params: Promise.resolve({ id, category }) });
const MOCK_ADDRESS = `${MOCK_FORWARDING_TOKEN}@inbound.gladrags.test`;

function json(path: string, method: string, body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const get = (path: string) => new Request(`${BASE}${path}`);

function form(path: string, method: string, fields: Record<string, string | File>): Request {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return new Request(`${BASE}${path}`, { method, body: data });
}

function fileOf(magic: number[], name: string, type: string, size = 1024): File {
  const bytes = new Uint8Array(size);
  bytes.set(magic);
  return new File([bytes], name, { type });
}
const jpeg = (name = "photo.jpg", size?: number) => fileOf([0xff, 0xd8, 0xff, 0xe0], name, "image/jpeg", size);
const png = (size?: number) => fileOf([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "cutout.png", "image/png", size);

async function expectError(response: Response, code: ApiErrorCode) {
  expect(response.status).toBe(API_ERROR_STATUS[code]);
  const body = ApiErrorSchema.parse(await response.json());
  expect(body.error.code).toBe(code);
  return body.error;
}

function emailBody(overrides: Record<string, unknown> = {}) {
  return {
    messageId: `<${crypto.randomUUID()}@mail.example>`,
    from: MOCK_USER.email,
    to: [MOCK_ADDRESS],
    subject: "Fwd: Your M&S order",
    text: "Thanks for your order",
    html: null,
    receivedAt: "2026-10-30T10:00:00.000Z",
    auth: { spf: "pass", dkim: "pass", dmarc: "pass" },
    spam: { isSpam: false, score: 0 },
    ...overrides,
  };
}
const inbound = (overrides: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  inboundEmail.POST(json("/api/inbound/email", "POST", emailBody(overrides), headers));

async function importsList() {
  return EmailImportListResponseSchema.parse(await (await emailImports.GET(get("/api/email-imports"))).json()).imports;
}
async function reviewList() {
  return ItemListResponseSchema.parse(await (await items.GET(get("/api/items?needsReview=true"))).json()).items;
}
async function getUsage() {
  return UsageSummarySchema.parse(await (await usage.GET(get("/api/usage"))).json());
}
async function gapOutfits(): Promise<Outfit[]> {
  const res = await outfits.POST(json("/api/outfits", "POST", { style: { kind: "preset", presetId: "casual" }, includeShopItems: true }));
  const body = OutfitGenerationResponseSchema.parse(await res.json());
  if (body.status !== "ok") throw new Error("expected outfits");
  return body.outfits;
}
async function search(id: string) {
  return shopSearch.POST(json(`/api/outfits/${id}/shop-search`, "POST"), ctx(id));
}

beforeEach(() => {
  vi.stubEnv("GLADRAGS_MOCK_MODE", "true");
  vi.stubEnv("GLADRAGS_E2E", "");
  vi.stubEnv("INBOUND_EMAIL_DOMAIN", "");
  vi.stubEnv("INBOUND_EMAIL_PREFIX", "");
  resetMockStore();
  delete (globalThis as { __gladragsMockUsage?: unknown }).__gladragsMockUsage;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// The order email webhook
// ---------------------------------------------------------------------------

describe("order email webhook: who it accepts", () => {
  it("finds the token in any recipient, not just the first", async () => {
    await inbound({ to: ["someone@example.com", MOCK_ADDRESS.toUpperCase()] });
    expect((await importsList())[0]).toMatchObject({ status: "done", itemCount: 2 });
  });

  it("accepts the sender's address in any case", async () => {
    await inbound({ from: MOCK_USER.email.toUpperCase() });
    expect((await importsList())[0]?.status).toBe("done");
  });

  it.each([
    [`Mock User <${MOCK_USER.email}>`, "a display name"],
    [`"${MOCK_USER.email}" <attacker@evil.example>`, "a display name spoofing the user's address"],
  ])("refuses a from of %s (%s) as a bad request, adding nothing", async (from) => {
    await expectError(await inbound({ from }), "bad_request");
    expect(await importsList()).toEqual([]);
    expect(await reviewList()).toEqual([]);
  });

  it("records a subaddress of the user's address as sender_not_allowed", async () => {
    await inbound({ from: MOCK_USER.email.replace("@", "+orders@") });
    expect((await importsList())[0]).toMatchObject({ status: "failed", error: "sender_not_allowed" });
    expect(await reviewList()).toEqual([]);
  });

  it("records spam as failed_checks even when authentication passes", async () => {
    await inbound({ spam: { isSpam: true, score: 1 } });
    expect((await importsList())[0]).toMatchObject({ status: "failed", error: "failed_checks" });
  });

  it("records missing authentication verdicts as failed_checks", async () => {
    await inbound({ auth: {} });
    expect((await importsList())[0]).toMatchObject({ status: "failed", error: "failed_checks" });
  });

  it("ignores a subaddress on the forwarding address, and a lookalike domain, without a trace", async () => {
    await inbound({ to: [`${MOCK_FORWARDING_TOKEN}+x@inbound.gladrags.test`] });
    await inbound({ to: [`${MOCK_FORWARDING_TOKEN}@inbound.gladrags.test.evil.example`] });
    expect(await importsList()).toEqual([]);
  });

  it("an address from before a reset is ignored without a trace", async () => {
    await forwardingAddressRoute.POST(json("/api/settings/forwarding-address", "POST"));
    const res = await inbound();
    expect(await res.json()).toEqual({ received: true });
    expect(await importsList()).toEqual([]);
  });

  it("uses INBOUND_EMAIL_PREFIX: only the prefixed address on the provider's domain works", async () => {
    vi.stubEnv("INBOUND_EMAIL_DOMAIN", "inbound.postmarkapp.com");
    vi.stubEnv("INBOUND_EMAIL_PREFIX", "abc123+");
    await inbound({ to: [`${MOCK_FORWARDING_TOKEN}@inbound.postmarkapp.com`] });
    await inbound({ to: [MOCK_ADDRESS] });
    expect(await importsList()).toEqual([]);
    await inbound({ to: [`abc123+${MOCK_FORWARDING_TOKEN}@inbound.postmarkapp.com`] });
    expect((await importsList())[0]?.status).toBe("done");
  });
});

describe("order email webhook: input and caps", () => {
  it("refuses a body over the size limit before reading it as an email", async () => {
    const big = emailBody({ text: "x".repeat(INBOUND_WEBHOOK_MAX_BYTES) });
    await expectError(await inboundEmail.POST(json("/api/inbound/email", "POST", big)), "bad_request");
    expect(await importsList()).toEqual([]);
  });

  it("counts the limit in bytes, not characters", async () => {
    const big = emailBody({ text: "é".repeat(INBOUND_WEBHOOK_MAX_BYTES / 2 + 10) });
    await expectError(await inboundEmail.POST(json("/api/inbound/email", "POST", big)), "bad_request");
  });

  it.each([
    ["", "an empty body"],
    ["[]", "a JSON array"],
    ["null", "JSON null"],
    ['{"messageId": "<1@x>"', "truncated JSON"],
  ])("refuses %j (%s)", async (body) => {
    const res = await inboundEmail.POST(new Request(`${BASE}/api/inbound/email`, { method: "POST", headers: { "content-type": "application/json" }, body }));
    await expectError(res, "bad_request");
  });

  it("refuses a browser post from another site (the CSRF check still runs)", async () => {
    await expectError(await inbound({}, { origin: "https://evil.example" }), "forbidden");
    await expectError(await inbound({}, { "sec-fetch-site": "cross-site" }), "forbidden");
    expect(await importsList()).toEqual([]);
  });

  it(`accepts ${DAILY_CAPS.email_import} emails a day, then records daily_cap_reached and adds nothing`, async () => {
    for (let i = 0; i < DAILY_CAPS.email_import; i++) await inbound();
    const before = (await reviewList()).length;
    const res = await inbound();
    expect(await res.json()).toEqual({ received: true });
    expect((await importsList())[0]).toMatchObject({ status: "failed", error: "daily_cap_reached", itemCount: 0 });
    expect((await reviewList()).length).toBe(before);
    expect((await getUsage()).emailsToday).toEqual({ used: DAILY_CAPS.email_import, limit: DAILY_CAPS.email_import });
  });

  it("refused emails don't use up the daily email cap", async () => {
    for (let i = 0; i < DAILY_CAPS.email_import + 2; i++) await inbound({ from: "stranger@example.com" });
    expect((await getUsage()).emailsToday.used).toBe(0);
    await inbound();
    expect((await importsList())[0]?.status).toBe("done");
  });

  it("an accepted email's items come in to review, one needing a photo, from source email", async () => {
    await inbound();
    const added = await reviewList();
    expect(added).toHaveLength(2);
    expect(added.every((i) => i.source === "email" && i.needsReview)).toBe(true);
    expect(added.filter((i) => i.needsPhoto)).toHaveLength(1);
  });

  // Fixed (was BUG, low, mock only): CONTRACTS.md step 3 skips a redelivered email
  // (same message ID for the user). The mock webhook imports it again, so
  // the UI agents never see the de-duplicated behaviour (and the e2e for
  // C7 would count twice). The real webhook is C3's.
  it("a redelivered email (same message ID) is imported once", async () => {
    const once = { messageId: "<same@mail.example>" };
    await inbound(once);
    await inbound(once);
    expect(await importsList()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

describe("settings", () => {
  const put = (body: unknown, headers: Record<string, string> = {}) => settings.PUT(json("/api/settings", "PUT", body, headers));

  it.each([
    [{ favouriteShopIds: ["next", "next"] }, "a duplicate"],
    [{ favouriteShopIds: [] }, "no shops"],
    [{ favouriteShopIds: ["primark"] }, "a shop not on the list"],
    [{ favouriteShopIds: "next" }, "a string, not a list"],
    [{}, "nothing"],
  ])("refuses %j (%s) and keeps the old shops", async (body, _label: unknown) => {
    await expectError(await put(body), "bad_request");
    const current = UserSettingsSchema.parse(await (await settings.GET(get("/api/settings"))).json());
    expect(current.favouriteShopIds).toEqual(["next", "marks_and_spencer", "new_look"]);
  });

  it("can't change the forwarding address through PUT", async () => {
    const before = UserSettingsSchema.parse(await (await settings.GET(get("/api/settings"))).json());
    const res = await put({ favouriteShopIds: ["zara"], forwardingAddress: "attacker@evil.example", forwardingToken: "f".repeat(32) });
    const after = UserSettingsSchema.parse(await res.json());
    expect(after.favouriteShopIds).toEqual(["zara"]);
    expect(after.forwardingAddress).toBe(before.forwardingAddress);
  });

  it("refuses a cross-site change", async () => {
    await expectError(await put({ favouriteShopIds: ["zara"] }, { origin: "https://evil.example" }), "forbidden");
    await expectError(
      await forwardingAddressRoute.POST(json("/api/settings/forwarding-address", "POST", undefined, { origin: "https://evil.example" })),
      "forbidden",
    );
  });

  it("a malformed INBOUND_EMAIL_DOMAIN is a configuration error, not a bad address", async () => {
    vi.stubEnv("INBOUND_EMAIL_DOMAIN", "not a domain");
    await expectError(await settings.GET(get("/api/settings")), "server_misconfigured");
  });

  // Fixed (was BUG, low): INBOUND_EMAIL_PREFIX's check (/^[a-z0-9._+-]{0,40}$/) allows
  // a leading dot or two dots in a row, which make an invalid address. The
  // settings response then fails its own schema: 500 internal instead of a
  // server_misconfigured that names the variable.
  it("a prefix that can't make a valid address is a configuration error", async () => {
    vi.stubEnv("INBOUND_EMAIL_PREFIX", "a..b+");
    await expectError(await settings.GET(get("/api/settings")), "server_misconfigured");
  });

  it("resetting twice gives two different addresses, both valid", async () => {
    const a = UserSettingsSchema.parse(await (await forwardingAddressRoute.POST(json("/api/settings/forwarding-address", "POST"))).json());
    const b = UserSettingsSchema.parse(await (await forwardingAddressRoute.POST(json("/api/settings/forwarding-address", "POST"))).json());
    expect(a.forwardingAddress).not.toBe(b.forwardingAddress);
    expect(b.forwardingAddress).toMatch(/^[0-9a-f]{32}@inbound\.gladrags\.test$/);
  });
});

// ---------------------------------------------------------------------------
// Gaps and shop search
// ---------------------------------------------------------------------------

describe("shop search", () => {
  it("only returns products on the user's current favourite shops, each a valid product", async () => {
    await settings.PUT(json("/api/settings", "PUT", { favouriteShopIds: ["zara", "asos"] }));
    const [outfit] = await gapOutfits();
    const found = OutfitResponseSchema.parse(await (await search(outfit!.id)).json()).outfit;
    for (const gap of found.gaps) {
      expect(gap.shopResults.length).toBeGreaterThan(0);
      expect(gap.shopResults.length).toBeLessThanOrEqual(3);
      for (const product of gap.shopResults) {
        expect(ShopProductSchema.safeParse(product).success).toBe(true);
        expect(shopForUrl(product.url, ["zara", "asos"])).toBe(product.shopId);
      }
      expect(gap.searchedAt).not.toBeNull();
    }
  });

  it(`allows ${DAILY_CAPS.shop_search} searches a day, then 429 shop_searches_per_day`, async () => {
    const [outfit] = await gapOutfits();
    for (let i = 0; i < DAILY_CAPS.shop_search; i++) expect((await search(outfit!.id)).status).toBe(200);
    const error = await expectError(await search(outfit!.id), "daily_cap_reached");
    expect(error.cap?.kind).toBe("shop_searches_per_day");
    expect((await getUsage()).shopSearchesToday.used).toBe(DAILY_CAPS.shop_search);
  });

  it("a refused search (no gaps, unknown outfit) isn't counted", async () => {
    const plain = OutfitGenerationResponseSchema.parse(
      await (await outfits.POST(json("/api/outfits", "POST", { style: { kind: "preset", presetId: "casual" } }))).json(),
    );
    if (plain.status !== "ok") throw new Error("expected outfits");
    await expectError(await search(plain.outfits[0]!.id), "bad_request");
    await expectError(await search(crypto.randomUUID()), "not_found");
    // A malformed ID can't match a row, so it reads as not_found (parseRouteParams).
    await expectError(await shopSearch.POST(json("/api/outfits/x/shop-search", "POST"), ctx("not-a-uuid")), "not_found");
    expect((await getUsage()).shopSearchesToday.used).toBe(0);
  });

  it("a search keeps a product already chosen", async () => {
    const [outfit] = await gapOutfits();
    const found = OutfitResponseSchema.parse(await (await search(outfit!.id)).json()).outfit;
    const gap = found.gaps[0]!;
    await gapProduct.PUT(json("/x", "PUT", { productUrl: gap.shopResults[0]!.url }), gapCtx(outfit!.id, gap.category));
    const again = OutfitResponseSchema.parse(await (await search(outfit!.id)).json()).outfit;
    expect(again.gaps[0]!.shopProduct?.url).toBe(gap.shopResults[0]!.url);
  });

  it("refuses a cross-site search (it spends the user's cap)", async () => {
    const [outfit] = await gapOutfits();
    const res = await shopSearch.POST(json(`/api/outfits/${outfit!.id}/shop-search`, "POST", undefined, { origin: "https://evil.example" }), ctx(outfit!.id));
    await expectError(res, "forbidden");
  });
});

describe("choosing a gap's product", () => {
  async function searched() {
    const [a, b] = await gapOutfits();
    const one = OutfitResponseSchema.parse(await (await search(a!.id)).json()).outfit;
    const two = OutfitResponseSchema.parse(await (await search(b!.id)).json()).outfit;
    return { one, two };
  }
  const choose = (id: string, category: string, productUrl: unknown) => gapProduct.PUT(json("/x", "PUT", { productUrl }), gapCtx(id, category));

  it("refuses a product before any search", async () => {
    const [outfit] = await gapOutfits();
    await expectError(await choose(outfit!.id, "shoes", "https://www.next.co.uk/mock-product/x-0"), "bad_request");
  });

  it("refuses another outfit's result, and any made-up link on a favourite shop", async () => {
    const { one, two } = await searched();
    await expectError(await choose(one.id, "shoes", two.gaps[0]!.shopResults[0]!.url), "bad_request");
    await expectError(await choose(one.id, "shoes", "https://www.next.co.uk/anything"), "bad_request");
    await expectError(await choose(one.id, "shoes", `${one.gaps[0]!.shopResults[0]!.url}?x=1`), "bad_request");
  });

  it("not_found for a slot with no gap, an unknown outfit or an unknown category; bad_request for a bad link", async () => {
    const { one } = await searched();
    const url = one.gaps[0]!.shopResults[0]!.url;
    await expectError(await choose(one.id, "top", url), "not_found");
    await expectError(await choose(crypto.randomUUID(), "shoes", url), "not_found");
    await expectError(await choose(one.id, "accessory", url), "not_found");
    await expectError(await choose(one.id, "shoes", "javascript:alert(1)"), "bad_request");
  });

  it("stores the server's copy of the product, whatever else the phone sends", async () => {
    const { one } = await searched();
    const result = one.gaps[0]!.shopResults[0]!;
    const res = await gapProduct.PUT(
      json("/x", "PUT", { productUrl: result.url, shopProduct: { ...result, title: "Planted", imageUrl: "https://evil.example/x.png" } }),
      gapCtx(one.id, "shoes"),
    );
    expect(OutfitResponseSchema.parse(await res.json()).outfit.gaps[0]!.shopProduct).toEqual(result);
  });
});

describe("gap outfits in mock mode", () => {
  it("every canned gap outfit keeps the composition rule and has at least one owned item", async () => {
    for (const outfit of await gapOutfits()) {
      expect(outfit.itemIds.length).toBeGreaterThanOrEqual(1);
      expect(outfit.itemIds.length + outfit.gaps.length).toBeLessThanOrEqual(4);
      expect(outfit.request.includeShopItems).toBe(true);
    }
  });

  // Fixed (was BUG, low, mock only): "Include items from my shops" returns
  // missingCategories: ["shoes"], although the mock wardrobe has three pairs
  // of shoes. CONTRACTS.md: missingCategories is "empty when the wardrobe
  // has everything"; a shop-item gap isn't a missing category. Building
  // against this, the outfit UI would tell a user with shoes to add shoes.
  // (The mock-gaps marker documents ["shoes"] on purpose; this is about
  // includeShopItems.)
  it("includeShopItems on a wardrobe with shoes reports no missing categories", async () => {
    const res = await outfits.POST(json("/api/outfits", "POST", { style: { kind: "preset", presetId: "casual" }, includeShopItems: true }));
    const body = OutfitGenerationResponseSchema.parse(await res.json());
    expect(body.status === "ok" && body.missingCategories).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Review flags, batch adds, item images
// ---------------------------------------------------------------------------

describe("reviewing and batch adds", () => {
  const batchPhoto = (fields: Record<string, string | File>) => itemPhoto.POST(form("/api/items/photo", "POST", { original: jpeg(), ...fields }));

  it("refuses a saveForReview that isn't true or false, naming the field", async () => {
    const error = await expectError(await batchPhoto({ saveForReview: "please" }), "bad_request");
    expect(error.issues?.[0]?.path).toBe("saveForReview");
  });

  it("a batch add over the daily item cap is a 429 and saves nothing", async () => {
    const res = await itemPhoto.POST(form("/api/items/photo", "POST", { original: jpeg("mock-daily-cap.jpg"), saveForReview: "true" }));
    const error = await expectError(res, "daily_cap_reached");
    expect(error.cap?.kind).toBe("items_per_day");
    expect(await reviewList()).toEqual([]);
  });

  it("a saved batch item is to review and only in the needsReview=true list", async () => {
    const saved = BatchAddResponseSchema.parse(await (await batchPhoto({ saveForReview: "true" })).json());
    if (saved.status !== "saved") throw new Error("expected a saved item");
    expect(saved.item.needsReview).toBe(true);
    expect((await reviewList()).map((i) => i.id)).toEqual([saved.item.id]);
    const reviewed = ItemListResponseSchema.parse(await (await items.GET(get("/api/items?needsReview=false"))).json()).items;
    expect(reviewed.map((i) => i.id)).not.toContain(saved.item.id);
    await expectError(await items.GET(get("/api/items?needsReview=maybe")), "bad_request");
  });

  it("PATCH with new tags also clears to review, and marks the tags edited", async () => {
    const saved = BatchAddResponseSchema.parse(await (await batchPhoto({ saveForReview: "true" })).json());
    if (saved.status !== "saved") throw new Error("expected a saved item");
    const res = await itemById.PATCH(json(`/api/items/${saved.item.id}`, "PATCH", { tags: { ...saved.item.tags, description: "Edited" } }), ctx(saved.item.id));
    const { item } = ItemResponseSchema.parse(await res.json());
    expect(item).toMatchObject({ needsReview: false, tagsEdited: true });
  });

  it("PATCH reviewed: true keeps tagsEdited false", async () => {
    const saved = BatchAddResponseSchema.parse(await (await batchPhoto({ saveForReview: "true" })).json());
    if (saved.status !== "saved") throw new Error("expected a saved item");
    const res = await itemById.PATCH(json(`/api/items/${saved.item.id}`, "PATCH", { reviewed: true }), ctx(saved.item.id));
    expect(ItemResponseSchema.parse(await res.json()).item).toMatchObject({ needsReview: false, tagsEdited: false });
  });

  it.each([
    [{ itemIds: [] }, "no IDs"],
    [{ itemIds: [MOCK_ITEMS[0]!.id, MOCK_ITEMS[0]!.id] }, "a duplicate"],
    [{ itemIds: Array.from({ length: 101 }, () => crypto.randomUUID()) }, "101 IDs"],
    [{ itemIds: ["../../etc"] }, "a non-UUID"],
  ])("Confirm all refuses %j (%s)", async (body) => {
    await expectError(await itemsReviewed.POST(json("/api/items/reviewed", "POST", body)), "bad_request");
  });

  it("Confirm all refuses a cross-site post", async () => {
    const res = await itemsReviewed.POST(json("/api/items/reviewed", "POST", { itemIds: [MOCK_ITEMS[0]!.id] }, { origin: "https://evil.example" }));
    await expectError(res, "forbidden");
  });
});

describe("item images after adding", () => {
  const id = MOCK_ITEMS[0]!.id;

  it("refuses a cut-out over 2.5 MB, and a photo over 1.5 MB", async () => {
    await expectError(await itemCutout.PUT(form(`/api/items/${id}/cutout`, "PUT", { cutout: png(2.5 * 1024 * 1024 + 1) }), ctx(id)), "bad_request");
    await expectError(await itemPhotoReplace.PUT(form(`/api/items/${id}/photo`, "PUT", { original: jpeg("a.jpg", 1.5 * 1024 * 1024 + 1) }), ctx(id)), "bad_request");
  });

  it("refuses a cut-out sent under the wrong field name, or as text", async () => {
    await expectError(await itemCutout.PUT(form(`/api/items/${id}/cutout`, "PUT", { original: png() }), ctx(id)), "bad_request");
    await expectError(await itemCutout.PUT(form(`/api/items/${id}/cutout`, "PUT", { cutout: "iVBORw0KGgo=" }), ctx(id)), "bad_request");
    await expectError(await itemCutout.PUT(json(`/api/items/${id}/cutout`, "PUT", { cutout: "x" }), ctx(id)), "bad_request");
  });

  it("refuses a PNG declared as a JPEG for the photo only if the bytes aren't an image; a GIF is refused", async () => {
    const gif = fileOf([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], "a.jpg", "image/jpeg");
    await expectError(await itemPhotoReplace.PUT(form(`/api/items/${id}/photo`, "PUT", { original: gif }), ctx(id)), "bad_request");
  });

  it("a malformed item id is not_found", async () => {
    await expectError(await itemCutout.PUT(form("/api/items/x/cutout", "PUT", { cutout: png() }), ctx("not-a-uuid")), "not_found");
  });

  it("refuses cross-site image uploads", async () => {
    const req = new Request(`${BASE}/api/items/${id}/cutout`, { method: "PUT", body: (() => { const d = new FormData(); d.set("cutout", png()); return d; })(), headers: { origin: "https://evil.example" } });
    await expectError(await itemCutout.PUT(req, ctx(id)), "forbidden");
  });

  it("a new photo clears needsPhoto and the cut-out, and marks the item to review", async () => {
    const res = await itemPhotoReplace.PUT(form(`/api/items/${id}/photo`, "PUT", { original: jpeg() }), ctx(id));
    expect(ItemResponseSchema.parse(await res.json()).item).toMatchObject({ needsPhoto: false, cutoutUrl: null, needsReview: true });
  });
});
