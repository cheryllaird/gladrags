/**
 * QA (round 2, P1): the outfit preview route in mock mode, adversarially:
 * the markers (fails, cap, paused), the missing preset, the daily cap at
 * exactly 12, refresh after a product pick (and after clearing it), reuse
 * across outfits (ready, failed and skipped looks), bursts of POSTs, items
 * deleted or re-photographed, and bad input.
 *
 * `it.fails` marks a known bug reported to the orchestrator.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiErrorSchema,
  OutfitGenerationResponseSchema,
  OutfitListResponseSchema,
  OutfitResponseSchema,
  PREVIEW_NEEDS_PRESET_ISSUE_PATH,
  UsageSummarySchema,
  type Outfit,
  type OutfitGap,
} from "@/contracts";
import { MOCK_PREVIEW_IMAGE_URL, MOCK_PREVIEW_WITH_SUGGESTIONS_IMAGE_URL } from "@/lib/mocks/previews";
import * as mockStore from "@/lib/mocks/store";
import * as gapProduct from "./outfits/[id]/gaps/[category]/route";
import * as preview from "./outfits/[id]/preview/route";
import * as shopSearch from "./outfits/[id]/shop-search/route";
import * as outfitById from "./outfits/[id]/route";
import * as outfits from "./outfits/route";
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

async function expectError(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  const body = ApiErrorSchema.parse(await response.json());
  expect(body.error.code).toBe(code);
  return body.error;
}

async function makeOutfits(body: Record<string, unknown> = {}): Promise<Outfit[]> {
  const res = await outfits.POST(json("/api/outfits", "POST", { style: { kind: "preset", presetId: "casual" }, ...body }));
  const parsed = OutfitGenerationResponseSchema.parse(await res.json());
  if (parsed.status !== "ok") throw new Error("expected outfits");
  return parsed.outfits;
}

const postPreview = (id: string, query = "") => preview.POST(json(`/api/outfits/${id}/preview${query}`, "POST"), ctx(id));

async function previewOk(id: string, query = ""): Promise<Outfit> {
  const res = await postPreview(id, query);
  expect(res.status).toBe(200);
  return OutfitResponseSchema.parse(await res.json()).outfit;
}

async function getOutfit(id: string): Promise<Outfit> {
  return OutfitResponseSchema.parse(await (await outfitById.GET(new Request(`${BASE}/x`), ctx(id))).json()).outfit;
}

async function previewsToday(): Promise<number> {
  return UsageSummarySchema.parse(await (await usage.GET(new Request(`${BASE}/api/usage`))).json()).outfitPreviewsToday.used;
}

/** A copy of an outfit with a distinct look (its gap described differently), saved in the mock store. */
function lookVariant(base: Outfit, n: number, extra: Partial<Outfit> = {}): Outfit {
  const gap: OutfitGap = {
    category: "shoes",
    subcategory: null,
    colours: ["black"],
    description: `Variant ${n}`,
    shopResults: [],
    searchedAt: null,
    shopProduct: null,
  };
  const items = base.items.filter((i) => i.tags.category !== "shoes").slice(0, 2);
  return mockStore.insertOutfit({ ...base, id: crypto.randomUUID(), items, itemIds: items.map((i) => i.id), gaps: [gap], ...extra });
}

async function pickFirstProduct(outfit: Outfit): Promise<Outfit> {
  const searched = OutfitResponseSchema.parse(await (await shopSearch.POST(json("/x", "POST"), ctx(outfit.id))).json()).outfit;
  const gap = searched.gaps[0]!;
  return chooseProduct(outfit.id, gap.category, gap.shopResults[0]!.url);
}

async function chooseProduct(id: string, category: string, productUrl: string | null): Promise<Outfit> {
  const res = await gapProduct.PUT(json("/x", "PUT", { productUrl }), { params: Promise.resolve({ id, category }) });
  expect(res.status).toBe(200);
  return OutfitResponseSchema.parse(await res.json()).outfit;
}

beforeEach(() => {
  vi.stubEnv("GLADRAGS_MOCK_MODE", "true");
  vi.stubEnv("GLADRAGS_MOCK_PREVIEW_DELAY_MS", "0");
  vi.stubEnv("INBOUND_EMAIL_DOMAIN", "");
  mockStore.resetMockStore();
  delete (globalThis as { __gladragsMockUsage?: unknown }).__gladragsMockUsage;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("QA: no preset picked", () => {
  it("answers bad_request on modelPresetId, counts nothing and leaves the preview none", async () => {
    const [outfit] = await makeOutfits();
    vi.spyOn(mockStore, "getSettings").mockReturnValue({ ...mockStore.getSettings(), modelPresetId: null });
    const error = await expectError(await postPreview(outfit!.id), 400, "bad_request");
    expect(error.issues).toEqual([expect.objectContaining({ path: PREVIEW_NEEDS_PRESET_ISSUE_PATH })]);
    expect(PREVIEW_NEEDS_PRESET_ISSUE_PATH).toBe("modelPresetId");
    // Refresh too.
    await expectError(await postPreview(outfit!.id, "?refresh=true"), 400, "bad_request");
    vi.restoreAllMocks();
    expect((await getOutfit(outfit!.id)).preview.status).toBe("none");
    expect(await previewsToday()).toBe(0);
  });

  it("an unknown outfit is not_found even with no preset (ownership before settings)", async () => {
    vi.spyOn(mockStore, "getSettings").mockReturnValue({ ...mockStore.getSettings(), modelPresetId: null });
    await expectError(await postPreview(crypto.randomUUID()), 404, "not_found");
  });
});

describe("QA: bad input", () => {
  it("a malformed id is not_found; a malformed refresh flag is bad_request", async () => {
    await expectError(await preview.POST(json("/api/outfits/nope/preview", "POST"), ctx("nope")), 404, "not_found");
    const [outfit] = await makeOutfits();
    await expectError(await postPreview(outfit!.id, "?refresh=maybe"), 400, "bad_request");
    expect(await previewsToday()).toBe(0);
  });

  it("refresh=false and refresh=1 parse as booleans", async () => {
    const [outfit] = await makeOutfits();
    expect((await previewOk(outfit!.id, "?refresh=false")).preview.status).toBe("ready");
    expect((await previewOk(outfit!.id, "?refresh=1")).preview.status).toBe("ready");
    expect(await previewsToday()).toBe(1);
  });
});

describe("QA: markers", () => {
  it("mock-preview-fails: counted once, then final (a second POST doesn't count or regenerate)", async () => {
    const [outfit] = await makeOutfits({ guidance: "Please MOCK-PREVIEW-FAILS here" });
    await expectError(await postPreview(outfit!.id), 502, "ai_failed");
    expect(await previewsToday()).toBe(1);
    const again = await previewOk(outfit!.id);
    expect(again.preview).toMatchObject({ status: "failed", failureReason: "ai_failed", imageUrl: null, presetId: "women_average_medium" });
    expect(await previewsToday()).toBe(1);
  });

  it("markers work in a custom style's text too", async () => {
    const [outfit] = await makeOutfits({ style: { kind: "custom", text: "quiet luxury mock-preview-paused" } });
    const error = await expectError(await postPreview(outfit!.id), 503, "ai_paused");
    expect(error.cap?.kind).toBe("monthly_image_spend");
    expect((await getOutfit(outfit!.id)).preview).toMatchObject({ status: "skipped", failureReason: "ai_paused", imageUrl: null });
  });

  it("mock-preview-cap: skipped, tried again by a later POST (and refused again), counting nothing", async () => {
    const [outfit] = await makeOutfits({ guidance: "mock-preview-cap" });
    await expectError(await postPreview(outfit!.id), 429, "daily_cap_reached");
    const error = await expectError(await postPreview(outfit!.id), 429, "daily_cap_reached");
    expect(error.cap).toMatchObject({ kind: "outfit_previews_per_day", limit: 12 });
    expect((await getOutfit(outfit!.id)).preview).toMatchObject({ status: "skipped", failureReason: "daily_cap_reached" });
    expect(await previewsToday()).toBe(0);
  });

  it("the generic mock markers don't stop previews (they're for the outfit request)", async () => {
    const [outfit] = await makeOutfits({ guidance: "mock-gaps" });
    expect((await previewOk(outfit!.id)).preview.status).toBe("ready");
  });
});

describe("QA: the daily cap at exactly 12", () => {
  it("the 13th distinct look is refused, reads skipped, and a reuse still works after the cap", async () => {
    const [base] = await makeOutfits();
    const looks = Array.from({ length: 13 }, (_, n) => lookVariant(base!, n));
    for (const look of looks.slice(0, 12)) expect((await previewOk(look.id)).preview.status).toBe("ready");
    expect(await previewsToday()).toBe(12);

    await expectError(await postPreview(looks[12]!.id), 429, "daily_cap_reached");
    expect((await getOutfit(looks[12]!.id)).preview).toMatchObject({ status: "skipped", failureReason: "daily_cap_reached" });
    expect(await previewsToday()).toBe(12);

    // A new outfit with an already-made look is free, cap or no cap.
    const twin = mockStore.insertOutfit({ ...looks[3]!, id: crypto.randomUUID(), itemIds: [...looks[3]!.itemIds].reverse() });
    expect((await previewOk(twin.id)).preview).toMatchObject({ status: "ready", imageUrl: MOCK_PREVIEW_WITH_SUGGESTIONS_IMAGE_URL });
    expect(await previewsToday()).toBe(12);
  });
});

describe("QA: reuse across outfits", () => {
  it("a twin of a failed look reads failed at once, with no cost and no retry", async () => {
    const [failing] = await makeOutfits({ guidance: "mock-preview-fails" });
    await expectError(await postPreview(failing!.id), 502, "ai_failed");
    const twin = mockStore.insertOutfit({ ...failing!, id: crypto.randomUUID(), request: { ...failing!.request, guidance: "fine now" } });
    expect((await previewOk(twin.id)).preview).toMatchObject({ status: "failed", failureReason: "ai_failed" });
    expect(await previewsToday()).toBe(1);
  });

  it("a twin of a skipped look generates it (skipped isn't final), and the first outfit then shows it too", async () => {
    const [capped] = await makeOutfits({ guidance: "mock-preview-cap" });
    await expectError(await postPreview(capped!.id), 429, "daily_cap_reached");
    const twin = mockStore.insertOutfit({ ...capped!, id: crypto.randomUUID(), request: { ...capped!.request, guidance: null } });
    expect((await previewOk(twin.id)).preview.status).toBe("ready");
    expect(await previewsToday()).toBe(1);
  });

  it("a burst of POSTs for twins of one look makes one picture; the rest wait, then all read ready", async () => {
    vi.stubEnv("GLADRAGS_MOCK_PREVIEW_DELAY_MS", "40");
    const [base] = await makeOutfits();
    const twins = [base!, ...Array.from({ length: 5 }, () => mockStore.insertOutfit({ ...base!, id: crypto.randomUUID() }))];
    const results = await Promise.all(twins.map((t) => previewOk(t.id)));
    expect(results.filter((o) => o.preview.status === "ready")).toHaveLength(1);
    expect(results.filter((o) => o.preview.status === "pending")).toHaveLength(5);
    expect(await previewsToday()).toBe(1);
    for (const t of twins) expect((await getOutfit(t.id)).preview).toMatchObject({ status: "ready", imageUrl: MOCK_PREVIEW_IMAGE_URL });
  });

  it("a burst of POSTs for one outfit makes one picture", async () => {
    vi.stubEnv("GLADRAGS_MOCK_PREVIEW_DELAY_MS", "40");
    const [outfit] = await makeOutfits();
    await Promise.all(Array.from({ length: 6 }, () => previewOk(outfit!.id)));
    expect(await previewsToday()).toBe(1);
  });

  it("the outfit list shows each outfit's own preview state", async () => {
    const [a, b] = await makeOutfits();
    await previewOk(a!.id);
    const list = OutfitListResponseSchema.parse(await (await outfits.GET(new Request(`${BASE}/api/outfits`))).json());
    const byId = new Map(list.outfits.map((o) => [o.id, o.preview.status]));
    expect(byId.get(a!.id)).toBe("ready");
    if (b && b.itemIds.join() !== a!.itemIds.join()) expect(byId.get(b.id)).toBe("none");
  });
});

describe("QA: refresh after a product pick", () => {
  it("refresh on an up-to-date preview is existing: no count, same picture", async () => {
    const [outfit] = await makeOutfits({ includeShopItems: true });
    await previewOk(outfit!.id);
    expect((await previewOk(outfit!.id, "?refresh=true")).preview).toMatchObject({ status: "ready", outdated: false });
    expect(await previewsToday()).toBe(1);
  });

  it("refresh twice after a pick counts once; a twin outfit with the old look keeps the old picture", async () => {
    const [outfit] = await makeOutfits({ includeShopItems: true });
    const twin = mockStore.insertOutfit({ ...outfit!, id: crypto.randomUUID() });
    await previewOk(outfit!.id);
    await previewOk(twin.id);
    expect(await previewsToday()).toBe(1);

    await pickFirstProduct(outfit!);
    expect((await getOutfit(twin.id)).preview.outdated).toBe(false);
    expect((await previewOk(outfit!.id, "?refresh=true")).preview).toMatchObject({ status: "ready", outdated: false });
    expect((await previewOk(outfit!.id, "?refresh=true")).preview.outdated).toBe(false);
    expect(await previewsToday()).toBe(2);
    expect((await getOutfit(twin.id)).preview).toMatchObject({ status: "ready", outdated: false });
  });

  it("a second outfit picking the same product reuses the refreshed picture for free", async () => {
    const [outfit] = await makeOutfits({ includeShopItems: true });
    const twin = mockStore.insertOutfit({ ...outfit!, id: crypto.randomUUID() });
    await previewOk(outfit!.id);
    await previewOk(twin.id);
    const picked = await pickFirstProduct(outfit!);
    await previewOk(outfit!.id, "?refresh=true");
    expect(await previewsToday()).toBe(2);
    // Same shop results (copied), same pick.
    mockStore.setOutfitGaps(twin.id, picked.gaps);
    expect((await getOutfit(twin.id)).preview.outdated).toBe(true);
    expect((await previewOk(twin.id, "?refresh=true")).preview).toMatchObject({ status: "ready", outdated: false });
    expect(await previewsToday()).toBe(2);
  });

  // Contract (CONTRACTS.md 12, "With ?refresh=true"): the route checks the
  // cap and the pause first, so a refresh that can't run leaves the
  // outdated picture in place. The mock claims (and drops the old picture)
  // before it reserves.
  it.fails("a refresh refused by the daily cap keeps the outdated picture (ready, outdated)", async () => {
    const [outfit] = await makeOutfits({ includeShopItems: true });
    await previewOk(outfit!.id);
    await pickFirstProduct(outfit!);
    for (let n = 0; n < 11; n++) await previewOk(lookVariant(outfit!, n).id);
    expect(await previewsToday()).toBe(12);
    await expectError(await postPreview(outfit!.id, "?refresh=true"), 429, "daily_cap_reached");
    expect((await getOutfit(outfit!.id)).preview).toMatchObject({ status: "ready", outdated: true, imageUrl: MOCK_PREVIEW_WITH_SUGGESTIONS_IMAGE_URL });
  });

  // Picking a product and then clearing it brings the outfit back to the
  // look its picture shows, but `outdated` stays true; "Update preview"
  // then answers existing and never clears it (the same in SQL).
  it.fails("picking then clearing a product leaves no stuck 'Update preview'", async () => {
    const [outfit] = await makeOutfits({ includeShopItems: true });
    await previewOk(outfit!.id);
    const picked = await pickFirstProduct(outfit!);
    await chooseProduct(outfit!.id, picked.gaps[0]!.category, null);
    const refreshed = await previewOk(outfit!.id, "?refresh=true");
    expect(refreshed.preview.outdated).toBe(false);
  });
});

describe("QA: items and the preset", () => {
  it("a new photo of an item resets its outfits' previews to none; a new cut-out keeps them", async () => {
    const [outfit] = await makeOutfits();
    await previewOk(outfit!.id);
    mockStore.setItemCutout(outfit!.itemIds[0]!);
    expect((await getOutfit(outfit!.id)).preview.status).toBe("ready");
    mockStore.replaceItemPhoto(outfit!.itemIds[0]!);
    expect((await getOutfit(outfit!.id)).preview).toMatchObject({ status: "none", imageUrl: null, presetId: null });
    // And the next POST makes a fresh one (counted).
    expect((await previewOk(outfit!.id)).preview.status).toBe("ready");
    expect(await previewsToday()).toBe(2);
  });

  it("a new photo of an item doesn't touch previews that don't show it", async () => {
    const made = await makeOutfits({ count: 3 });
    for (const o of made) await previewOk(o.id);
    const victim = made[0]!.itemIds[0]!;
    mockStore.replaceItemPhoto(victim);
    for (const o of made) {
      expect((await getOutfit(o.id)).preview.status).toBe(o.itemIds.includes(victim) ? "none" : "ready");
    }
  });

  it("after a preset change, a skipped look is retried on the new preset; ready and failed ones keep theirs", async () => {
    const [ready] = await makeOutfits();
    await previewOk(ready!.id);
    const [failed] = await makeOutfits({ guidance: "mock-preview-fails" });
    await postPreview(failed!.id);
    const [skipped] = await makeOutfits({ guidance: "x" });
    const skippedId = skipped!.id;
    // Make it skipped by the cap marker on a copy with the same look.
    const cappedTwin = mockStore.insertOutfit({ ...skipped!, id: crypto.randomUUID(), request: { ...skipped!.request, guidance: "mock-preview-cap" } });
    await postPreview(cappedTwin.id);

    await settings.PUT(json("/api/settings", "PUT", { modelPresetId: "men_plus_deep" }));
    expect((await previewOk(ready!.id)).preview.presetId).toBe("women_average_medium");
    expect((await previewOk(failed!.id)).preview).toMatchObject({ status: "failed", presetId: "women_average_medium" });
    expect((await previewOk(skippedId)).preview).toMatchObject({ status: "ready", presetId: "men_plus_deep" });
  });
});
