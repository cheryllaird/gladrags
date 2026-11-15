/**
 * Round 2: the outfit preview route stub and the model preset setting, in
 * mock mode (and once with mock mode off, where the stub must refuse).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiErrorSchema,
  OutfitGenerationResponseSchema,
  OutfitResponseSchema,
  OutfitListResponseSchema,
  PREVIEW_NEEDS_PRESET_ISSUE_PATH,
  previewCacheKey,
  UsageSummarySchema,
  UserSettingsSchema,
  type Outfit,
} from "@/contracts";
import { MOCK_ITEMS } from "@/lib/mocks/fixtures";
import { MOCK_PREVIEW_IMAGE_URL, MOCK_PREVIEW_WITH_SUGGESTIONS_IMAGE_URL } from "@/lib/mocks/previews";
import * as mockStore from "@/lib/mocks/store";
import * as itemById from "./items/[id]/route";
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

async function previewOf(id: string, query = ""): Promise<Response> {
  return preview.POST(json(`/api/outfits/${id}/preview${query}`, "POST"), ctx(id));
}

async function readyOutfit(id: string, query = ""): Promise<Outfit> {
  const res = await previewOf(id, query);
  expect(res.status).toBe(200);
  return OutfitResponseSchema.parse(await res.json()).outfit;
}

async function previewsToday(): Promise<number> {
  return UsageSummarySchema.parse(await (await usage.GET(new Request(`${BASE}/api/usage`))).json()).outfitPreviewsToday.used;
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
});

describe("POST /api/outfits/[id]/preview (mock mode)", () => {
  it("new outfits have no preview; the route makes one, ready with a mock picture", async () => {
    const [outfit] = await makeOutfits();
    expect(outfit!.preview).toMatchObject({ status: "none", imageUrl: null, outdated: false, suggestedSlots: [] });
    const done = await readyOutfit(outfit!.id);
    expect(done.preview).toEqual({
      status: "ready",
      imageUrl: MOCK_PREVIEW_IMAGE_URL,
      failureReason: null,
      presetId: "women_average_medium",
      suggestedSlots: [],
      outdated: false,
      refreshing: false,
    });
    expect(await previewsToday()).toBe(1);
    // Loading it again shows the stored preview.
    const again = OutfitResponseSchema.parse(await (await outfitById.GET(new Request(`${BASE}/x`), ctx(outfit!.id))).json());
    expect(again.outfit.preview.status).toBe("ready");
  });

  it("is idempotent: a second call returns the ready preview without counting", async () => {
    const [outfit] = await makeOutfits();
    await readyOutfit(outfit!.id);
    const again = await readyOutfit(outfit!.id);
    expect(again.preview.status).toBe("ready");
    expect(await previewsToday()).toBe(1);
  });

  it("reuses one image for an identical look in another outfit, at no cost", async () => {
    const [first] = await makeOutfits();
    await readyOutfit(first!.id);
    // A refinement or later request that lands on the same items and gaps,
    // in another order (the key sorts the items).
    const twin = mockStore.insertOutfit({ ...first!, id: crypto.randomUUID(), itemIds: [...first!.itemIds].reverse(), name: "Again" });
    expect(twin.preview.status).toBe("none");
    const reused = await readyOutfit(twin.id);
    expect(reused.preview.status).toBe("ready");
    expect(await previewsToday()).toBe(1);
    // A different look (one item fewer, a gap instead) is generated.
    const different = mockStore.insertOutfit({
      ...first!,
      id: crypto.randomUUID(),
      itemIds: first!.itemIds.slice(0, -1),
      items: first!.items.slice(0, -1),
      gaps: [{ category: first!.items.at(-1)!.tags.category, subcategory: null, colours: ["black"], description: "Black pair", shopResults: [], searchedAt: null, shopProduct: null }],
    });
    await readyOutfit(different.id);
    expect(await previewsToday()).toBe(2);
  });

  it("asks for a model preset first (bad_request on modelPresetId)", async () => {
    const [outfit] = await makeOutfits();
    vi.spyOn(mockStore, "getSettings").mockReturnValue({ ...mockStore.getSettings(), modelPresetId: null });
    const error = await expectError(await previewOf(outfit!.id), 400, "bad_request");
    expect(error.issues?.[0]?.path).toBe(PREVIEW_NEEDS_PRESET_ISSUE_PATH);
    vi.restoreAllMocks();
  });

  it("a gap outfit's preview shows the suggested pieces, and is labelled with their slots", async () => {
    const [outfit] = await makeOutfits({ includeShopItems: true });
    expect(outfit!.gaps.length).toBeGreaterThan(0);
    const done = await readyOutfit(outfit!.id);
    expect(done.preview.imageUrl).toBe(MOCK_PREVIEW_WITH_SUGGESTIONS_IMAGE_URL);
    expect(done.preview.suggestedSlots).toEqual(outfit!.gaps.map((g) => g.category));
  });

  it("picking a shop product marks the preview outdated; refresh makes a new one and counts it", async () => {
    const [outfit] = await makeOutfits({ includeShopItems: true });
    await readyOutfit(outfit!.id);
    const searched = OutfitResponseSchema.parse(await (await shopSearch.POST(json("/x", "POST"), ctx(outfit!.id))).json()).outfit;
    expect(searched.preview.outdated).toBe(false); // results alone don't change the look
    const gap = searched.gaps[0]!;
    const picked = OutfitResponseSchema.parse(
      await (
        await gapProduct.PUT(json("/x", "PUT", { productUrl: gap.shopResults[0]!.url }), {
          params: Promise.resolve({ id: outfit!.id, category: gap.category }),
        })
      ).json(),
    ).outfit;
    expect(picked.preview).toMatchObject({ status: "ready", outdated: true });

    // Without refresh, the outdated image stays as it is.
    expect((await readyOutfit(outfit!.id)).preview.outdated).toBe(true);
    expect(await previewsToday()).toBe(1);

    const refreshed = await readyOutfit(outfit!.id, "?refresh=true");
    expect(refreshed.preview).toMatchObject({ status: "ready", outdated: false });
    expect(await previewsToday()).toBe(2);
  });

  it("a refresh keeps the old picture while the new one is made (refreshing), then switches", async () => {
    vi.stubEnv("GLADRAGS_MOCK_PREVIEW_DELAY_MS", "50");
    const [outfit] = await makeOutfits({ includeShopItems: true });
    await readyOutfit(outfit!.id);
    const searched = OutfitResponseSchema.parse(await (await shopSearch.POST(json("/x", "POST"), ctx(outfit!.id))).json()).outfit;
    const gap = searched.gaps[0]!;
    await gapProduct.PUT(json("/x", "PUT", { productUrl: gap.shopResults[0]!.url }), { params: Promise.resolve({ id: outfit!.id, category: gap.category }) });
    const running = readyOutfit(outfit!.id, "?refresh=true");
    await new Promise((resolve) => setTimeout(resolve, 10));
    const during = mockStore.getOutfit(outfit!.id)!;
    expect(during.preview).toMatchObject({ status: "ready", outdated: true, refreshing: true, imageUrl: MOCK_PREVIEW_WITH_SUGGESTIONS_IMAGE_URL });
    // Asking again meanwhile waits for it: no second generation.
    expect((await readyOutfit(outfit!.id, "?refresh=true")).preview.refreshing).toBe(true);
    const after = await running;
    expect(after.preview).toMatchObject({ status: "ready", outdated: false, refreshing: false });
    expect(await previewsToday()).toBe(2);
  });

  // (Keeping the old picture through a failed refresh, and "unavailable",
  // are covered in SQL: rls.test.sql. In the mock a marker always fails, so
  // a marked outfit never has a picture to keep.)
  it("an ai_failed preview reads failed for an hour, then is tried again (and counted)", async () => {
    const [failing] = await makeOutfits({ guidance: "mock-preview-fails" });
    await expectError(await previewOf(failing!.id), 502, "ai_failed");
    const before = await previewsToday();
    expect((await readyOutfit(failing!.id)).preview).toMatchObject({ status: "failed", failureReason: "ai_failed" });
    expect(await previewsToday()).toBe(before);
    // A marked outfit's look is salted with the marker and its ID (markers come before reuse).
    const key = await previewCacheKey({
      presetId: `women_average_medium|mock-preview-fails|${failing!.id}`,
      itemIds: failing!.itemIds,
      gaps: failing!.gaps,
    });
    mockStore.agePreviewAttempt(key, 61 * 60 * 1000);
    await expectError(await previewOf(failing!.id), 502, "ai_failed");
    expect(await previewsToday()).toBe(before + 1);
  });

  it("mock-preview-fails: ai_failed, then the preview reads failed and isn't tried again", async () => {
    const [outfit] = await makeOutfits({ guidance: "mock-preview-fails" });
    await expectError(await previewOf(outfit!.id), 502, "ai_failed");
    const after = await readyOutfit(outfit!.id);
    expect(after.preview).toMatchObject({ status: "failed", failureReason: "ai_failed", imageUrl: null });
  });

  it("mock-preview-cap: daily_cap_reached, and the preview reads skipped", async () => {
    const [outfit] = await makeOutfits({ guidance: "mock-preview-cap" });
    const error = await expectError(await previewOf(outfit!.id), 429, "daily_cap_reached");
    expect(error.cap?.kind).toBe("outfit_previews_per_day");
    const list = OutfitListResponseSchema.parse(await (await outfits.GET(new Request(`${BASE}/api/outfits`))).json());
    expect(list.outfits.find((o) => o.id === outfit!.id)!.preview).toMatchObject({ status: "skipped", failureReason: "daily_cap_reached" });
  });

  it("mock-preview-paused: ai_paused on the images share", async () => {
    const [outfit] = await makeOutfits({ guidance: "mock-preview-paused" });
    const error = await expectError(await previewOf(outfit!.id), 503, "ai_paused");
    expect(error.cap?.kind).toBe("monthly_image_spend");
  });

  it("the daily preview cap (12) applies to real generations", async () => {
    const made: Outfit[] = [];
    for (const style of ["casual", "smart_casual", "work", "comfy", "evening_out"] as const) {
      const res = await outfits.POST(json("/api/outfits", "POST", { style: { kind: "preset", presetId: style }, count: 5 }));
      const body = OutfitGenerationResponseSchema.parse(await res.json());
      if (body.status === "ok") made.push(...body.outfits);
    }
    let generated = 0;
    let capped = false;
    for (const outfit of made) {
      const res = await previewOf(outfit.id);
      if (res.status === 429) {
        capped = true;
        break;
      }
      generated = await previewsToday();
    }
    expect(generated).toBeLessThanOrEqual(12);
    if (generated === 12) expect(capped || made.length <= 12).toBe(true);
  });

  it("deleting an item drops the previews that show it", async () => {
    const [outfit] = await makeOutfits();
    await readyOutfit(outfit!.id);
    const [other] = await makeOutfits();
    expect(other).toBeDefined();
    await itemById.DELETE(new Request(`${BASE}/x`, { method: "DELETE" }), ctx(outfit!.itemIds[0]!));
    // The outfit itself is gone (CONTRACTS.md decision 5), and so is its preview.
    expect(mockStore.getOutfit(outfit!.id)).toBeNull();
  });

  it("an unknown outfit is not_found", async () => {
    await expectError(await previewOf(MOCK_ITEMS[0]!.id), 404, "not_found");
  });

  it("refuses outside mock mode (not_implemented) until outfit-engine builds it", async () => {
    vi.stubEnv("GLADRAGS_MOCK_MODE", "false");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    const res = await previewOf("2b000000-0000-4000-8000-000000000001");
    expect([401, 500, 501]).toContain(res.status);
  });
});

describe("settings: the model preset (mock mode)", () => {
  it("starts with the default preset picked, and can be changed on its own", async () => {
    const before = UserSettingsSchema.parse(await (await settings.GET(new Request(`${BASE}/api/settings`))).json());
    expect(before.modelPresetId).toBe("women_average_medium");
    const after = UserSettingsSchema.parse(await (await settings.PUT(json("/api/settings", "PUT", { modelPresetId: "men_broad_deep" }))).json());
    expect(after.modelPresetId).toBe("men_broad_deep");
    expect(after.favouriteShopIds).toEqual(before.favouriteShopIds);
  });

  it("refuses an unknown preset, a null preset and an empty change", async () => {
    await expectError(await settings.PUT(json("/api/settings", "PUT", { modelPresetId: "women_broad_light" })), 400, "bad_request");
    await expectError(await settings.PUT(json("/api/settings", "PUT", { modelPresetId: null })), 400, "bad_request");
    await expectError(await settings.PUT(json("/api/settings", "PUT", {})), 400, "bad_request");
  });

  it("a preset change doesn't touch existing previews; new looks use the new preset", async () => {
    const [outfit] = await makeOutfits();
    await readyOutfit(outfit!.id);
    await settings.PUT(json("/api/settings", "PUT", { modelPresetId: "men_slim_light" }));
    expect((await readyOutfit(outfit!.id)).preview.presetId).toBe("women_average_medium");
    const [fresh] = await makeOutfits({ guidance: "something new" });
    expect((await readyOutfit(fresh!.id)).preview.presetId).toBe("men_slim_light");
  });
});
