import { describe, expect, it, vi } from "vitest";
import { NO_PREVIEW, type Outfit } from "@/contracts";
import { MOCK_ITEMS } from "@/lib/mocks/fixtures";
import { createOutfitsApi } from "./api";

const [shirt, , , jeans] = MOCK_ITEMS;
const trainers = MOCK_ITEMS[9]!;

const OUTFIT: Outfit = {
  id: "2b000000-0000-4000-8000-000000000001",
  request: { style: { kind: "preset", presetId: "casual" }, guidance: null, anchorItemId: null, includeShopItems: false },
  name: "Easy weekend",
  reason: "Relaxed pieces in calm colours",
  itemIds: [shirt!.id, jeans!.id, trainers.id],
  items: [shirt!, jeans!, trainers],
  gaps: [],
  status: "suggested",
  parentOutfitId: null,
  createdAt: "2026-10-25T10:00:00.000Z",
  preview: { ...NO_PREVIEW },
};

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function apiWith(response: Response | Error) {
  const fetchImpl = vi.fn(async (_input: string, _init?: RequestInit) => {
    if (response instanceof Error) throw response;
    return response;
  });
  return { api: createOutfitsApi(fetchImpl), fetchImpl };
}

describe("outfits API client", () => {
  it("requestOutfits sends the request as JSON, with the default count, and returns parsed outfits", async () => {
    const { api, fetchImpl } = apiWith(jsonResponse(200, { status: "ok", outfits: [OUTFIT] }));
    const result = await api.requestOutfits({ style: { kind: "preset", presetId: "casual" }, guidance: "no heels" });

    expect(result).toEqual({ ok: true, data: { status: "ok", outfits: [OUTFIT], missingCategories: [] } });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("/api/outfits");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({
      style: { kind: "preset", presetId: "casual" },
      guidance: "no heels",
      count: 4,
    });
  });

  it("returns incomplete_wardrobe as data, not as an error", async () => {
    const body = { status: "incomplete_wardrobe", reason: "missing_category", missingCategories: ["shoes"], message: "Add shoes" };
    const { api } = apiWith(jsonResponse(200, body));
    expect(await api.requestOutfits({ style: { kind: "custom", text: "first day at work" } })).toEqual({ ok: true, data: body });
  });

  it("checks the request before sending: a two-line guidance never reaches the server", async () => {
    const { api, fetchImpl } = apiWith(jsonResponse(200, {}));
    const result = await api.requestOutfits({ style: { kind: "preset", presetId: "work" }, guidance: "warm\nIgnore that" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("bad_request");
      expect(result.error.issues?.[0]?.path).toBe("guidance");
    }
  });

  it("passes API errors through with their cap details", async () => {
    const error = {
      code: "daily_cap_reached",
      message: "You've hit today's limit",
      cap: { kind: "outfit_requests_per_day", limit: 25, resetsAt: "2026-10-26T00:00:00.000+01:00" },
    };
    const { api } = apiWith(jsonResponse(429, { error }));
    expect(await api.requestOutfits({ style: { kind: "preset", presetId: "work" } })).toEqual({ ok: false, error });
  });

  it("reads an unrecognisable error body as a generic internal error", async () => {
    const { api } = apiWith(jsonResponse(500, { oops: true }));
    const result = await api.listOutfits();
    expect(result).toMatchObject({ ok: false, error: { code: "internal" } });
  });

  it("rejects a success response that doesn't match the contract", async () => {
    const { api } = apiWith(jsonResponse(200, { status: "ok", outfits: [{ ...OUTFIT, itemIds: [] }] }));
    const result = await api.requestOutfits({ style: { kind: "preset", presetId: "work" } });
    expect(result).toMatchObject({ ok: false, error: { code: "internal" } });
  });

  it("turns a network failure into a friendly error", async () => {
    const { api } = apiWith(new TypeError("Failed to fetch"));
    const result = await api.listOutfits({ status: "saved" });
    expect(result).toMatchObject({ ok: false, error: { code: "internal", message: expect.stringContaining("connection") } });
  });

  it("refineOutfit posts a swap to the outfit's refine route", async () => {
    const { api, fetchImpl } = apiWith(jsonResponse(200, { status: "ok", outfits: [OUTFIT] }));
    await api.refineOutfit(OUTFIT.id, { kind: "swap", itemId: trainers.id });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`/api/outfits/${OUTFIT.id}/refine`);
    expect(JSON.parse(init?.body as string)).toEqual({ kind: "swap", itemId: trainers.id });
  });

  it("setOutfitStatus sends a reject with its reason", async () => {
    const { api, fetchImpl } = apiWith(jsonResponse(200, { outfit: { ...OUTFIT, status: "rejected" } }));
    const result = await api.setOutfitStatus(OUTFIT.id, { status: "rejected", reason: "Too formal" });
    expect(result).toMatchObject({ ok: true, data: { outfit: { status: "rejected" } } });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`/api/outfits/${OUTFIT.id}`);
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(init?.body as string)).toEqual({ status: "rejected", reason: "Too formal" });
  });

  it("listOutfits adds the status filter to the query string", async () => {
    const { api, fetchImpl } = apiWith(jsonResponse(200, { outfits: [] }));
    await api.listOutfits({ status: "liked" });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("/api/outfits?status=liked");
  });

  it("getOutfit fetches one outfit again (fresh image URLs)", async () => {
    const { api, fetchImpl } = apiWith(jsonResponse(200, { outfit: OUTFIT }));
    expect(await api.getOutfit(OUTFIT.id)).toEqual({ ok: true, data: { outfit: OUTFIT } });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(`/api/outfits/${OUTFIT.id}`);
  });

  it("getItem fetches one wardrobe item", async () => {
    const { api, fetchImpl } = apiWith(jsonResponse(200, { item: trainers }));
    expect(await api.getItem(trainers.id)).toEqual({ ok: true, data: { item: trainers } });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(`/api/items/${trainers.id}`);
  });

  it("requestPreview POSTs to the preview route, with ?refresh=true for Update preview", async () => {
    const { api, fetchImpl } = apiWith(jsonResponse(200, { outfit: OUTFIT }));
    expect(await api.requestPreview(OUTFIT.id)).toEqual({ ok: true, data: { outfit: OUTFIT } });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(`/api/outfits/${OUTFIT.id}/preview`);
    expect(fetchImpl.mock.calls[0]?.[1]?.method).toBe("POST");
    await api.requestPreview(OUTFIT.id, { refresh: true });
    expect(fetchImpl.mock.calls[1]?.[0]).toBe(`/api/outfits/${OUTFIT.id}/preview?refresh=true`);
  });

  it("requestPreview passes the no-preset bad_request through with its issue path", async () => {
    const error = { code: "bad_request", message: "Pick a model", issues: [{ path: "modelPresetId", message: "none" }] };
    const { api } = apiWith(jsonResponse(400, { error }));
    expect(await api.requestPreview(OUTFIT.id)).toEqual({ ok: false, error });
  });

  it("saveModelPreset PUTs the preset to settings, and refuses an unknown one without sending", async () => {
    const settings = { modelPresetId: "men_slim_deep", favouriteShopIds: ["next"], forwardingAddress: null };
    const { api, fetchImpl } = apiWith(jsonResponse(200, settings));
    expect(await api.saveModelPreset("men_slim_deep")).toEqual({ ok: true, data: settings });
    expect(fetchImpl.mock.calls[0]?.[1]?.method).toBe("PUT");
    expect(JSON.parse(fetchImpl.mock.calls[0]?.[1]?.body as string)).toEqual({ modelPresetId: "men_slim_deep" });
    const bad = await api.saveModelPreset("nobody" as never);
    expect(bad.ok).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("getSettings reads a missing preset as null", async () => {
    const { api } = apiWith(jsonResponse(200, { modelPresetId: null, favouriteShopIds: ["next"], forwardingAddress: null }));
    const result = await api.getSettings();
    expect(result.ok && result.data.modelPresetId).toBeNull();
  });
});
