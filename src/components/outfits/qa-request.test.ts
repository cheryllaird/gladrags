// QA gap tests for the request draft, the typed API client and the error
// copy: limits at the boundary, invalid input that must never be sent, and
// odd server replies.
import { describe, expect, it, vi } from "vitest";
import { CUSTOM_STYLE_MAX_LENGTH, GUIDANCE_MAX_LENGTH, OutfitRequestSchema, type ApiErrorCode } from "@/contracts";
import { createOutfitsApi } from "./api";
import { describeApiError } from "./copy";
import { EMPTY_DRAFT, draftToRequest } from "./request-draft";

const ANCHOR = "1a000000-0000-4000-8000-000000000008";

describe("draftToRequest: limits and odd input", () => {
  it("a custom style of exactly the limit is accepted; one more is refused", () => {
    const max = draftToRequest({ ...EMPTY_DRAFT, style: "custom", customText: "a".repeat(CUSTOM_STYLE_MAX_LENGTH) }, null);
    expect(max.ok).toBe(true);
    const over = draftToRequest({ ...EMPTY_DRAFT, style: "custom", customText: "a".repeat(CUSTOM_STYLE_MAX_LENGTH + 1) }, null);
    expect(over).toMatchObject({ ok: false, field: "customText" });
  });

  it("guidance of exactly the limit is accepted; one more is refused", () => {
    const base = { ...EMPTY_DRAFT, style: "casual" as const };
    expect(draftToRequest({ ...base, guidance: "g".repeat(GUIDANCE_MAX_LENGTH) }, null).ok).toBe(true);
    expect(draftToRequest({ ...base, guidance: "g".repeat(GUIDANCE_MAX_LENGTH + 1) }, null)).toMatchObject({
      ok: false,
      field: "guidance",
    });
  });

  it("whitespace-only custom text counts as empty", () => {
    expect(draftToRequest({ ...EMPTY_DRAFT, style: "custom", customText: " \n\t " }, null)).toMatchObject({
      ok: false,
      field: "customText",
    });
  });

  it("whitespace that collapses brings long pasted guidance under the limit", () => {
    const guidance = `no${" ".repeat(300)}heels`;
    const result = draftToRequest({ ...EMPTY_DRAFT, style: "work", guidance }, null);
    expect(result).toMatchObject({ ok: true, request: { guidance: "no heels" } });
  });

  it("pasted multi-line text becomes one line (the contract refuses newlines)", () => {
    const result = draftToRequest({ ...EMPTY_DRAFT, style: "custom", customText: "summer\r\nwedding", guidance: "no\nheels" }, null);
    expect(result).toMatchObject({ ok: true, request: { style: { kind: "custom", text: "summer wedding" }, guidance: "no heels" } });
    if (result.ok) expect(OutfitRequestSchema.safeParse(result.request).success).toBe(true);
  });

  it("text typed under 'Something else' is dropped when a preset is chosen", () => {
    const result = draftToRequest({ ...EMPTY_DRAFT, style: "work", customText: "ignore me" }, null);
    expect(result).toEqual({ ok: true, request: { style: { kind: "preset", presetId: "work" }, count: 4 } });
  });

  it.each([3, 4, 5])("count %i is accepted", (count) => {
    expect(draftToRequest({ ...EMPTY_DRAFT, style: "comfy", count }, null)).toMatchObject({ ok: true, request: { count } });
  });

  it.each([0, 2, 6, 3.5])("count %s is refused", (count) => {
    expect(draftToRequest({ ...EMPTY_DRAFT, style: "comfy", count }, null).ok).toBe(false);
  });

  // QA finding, fixed: a contract failure that isn't about style (here: the
  // count) used to be reported against the "style" field.
  it("an out-of-range count is reported against the count, not the style", () => {
    expect(draftToRequest({ ...EMPTY_DRAFT, style: "comfy", count: 9 }, null)).toMatchObject({ field: "count" });
  });

  it("an anchor that isn't a valid ID is refused rather than sent", () => {
    expect(draftToRequest({ ...EMPTY_DRAFT, style: "work" }, "not-an-id").ok).toBe(false);
    expect(draftToRequest({ ...EMPTY_DRAFT, style: "work" }, ANCHOR)).toMatchObject({ ok: true, request: { anchorItemId: ANCHOR } });
  });
});

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("outfits API client: invalid input never reaches the server", () => {
  const fetchImpl = vi.fn(async (_input: string, _init?: RequestInit) => jsonResponse(200, {}));
  const api = createOutfitsApi(fetchImpl);

  it.each([
    ["empty guidance refine", () => api.refineOutfit(ANCHOR, { kind: "guidance", text: "   " })],
    ["over-long guidance refine", () => api.refineOutfit(ANCHOR, { kind: "guidance", text: "x".repeat(GUIDANCE_MAX_LENGTH + 1) })],
    ["two-line guidance refine", () => api.refineOutfit(ANCHOR, { kind: "guidance", text: "warmer\nplease" })],
    ["swap with a bad item ID", () => api.refineOutfit(ANCHOR, { kind: "swap", itemId: "nope" })],
    ["count of 6", () => api.requestOutfits({ style: { kind: "preset", presetId: "work" }, count: 6 })],
    ["unknown status", () => api.setOutfitStatus(ANCHOR, { status: "loved" } as never)],
    ["multi-line reject reason", () => api.setOutfitStatus(ANCHOR, { status: "rejected", reason: "too\nformal" })],
  ])("%s", async (_name, call) => {
    fetchImpl.mockClear();
    const result = await call();
    expect(result).toMatchObject({ ok: false, error: { code: "bad_request" } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("encodes the outfit ID into the path", async () => {
    fetchImpl.mockClear();
    await api.setOutfitStatus("a/b?c", { status: "saved" });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("/api/outfits/a%2Fb%3Fc");
  });
});

describe("outfits API client: odd server replies", () => {
  it("an HTML error page (not JSON) becomes a friendly internal error", async () => {
    const api = createOutfitsApi(async () => new Response("<html>502 Bad Gateway</html>", { status: 502 }));
    const result = await api.requestOutfits({ style: { kind: "preset", presetId: "work" } });
    expect(result).toMatchObject({ ok: false, error: { code: "internal" } });
  });

  it("an ok status with too many outfits (6) is refused, not shown", async () => {
    const api = createOutfitsApi(async () => jsonResponse(200, { status: "ok", outfits: new Array(6).fill({}) }));
    expect(await api.requestOutfits({ style: { kind: "preset", presetId: "work" } })).toMatchObject({ ok: false });
  });

  it("an ok status with no outfits is refused, not shown as an empty result", async () => {
    const api = createOutfitsApi(async () => jsonResponse(200, { status: "ok", outfits: [] }));
    expect(await api.requestOutfits({ style: { kind: "preset", presetId: "work" } })).toMatchObject({ ok: false });
  });

  it("a 404 for an anchor that's gone passes the not_found message through", async () => {
    const api = createOutfitsApi(async () => jsonResponse(404, { error: { code: "not_found", message: "That item wasn't found" } }));
    const result = await api.requestOutfits({ style: { kind: "preset", presetId: "work" }, anchorItemId: ANCHOR });
    expect(result).toEqual({ ok: false, error: { code: "not_found", message: "That item wasn't found" } });
  });
});

describe("describeApiError: without cap details", () => {
  it("ai_paused without a reset time says 'until next month'", () => {
    expect(describeApiError({ code: "ai_paused", message: "x" }).message).toContain("until next month");
  });

  it("daily_cap_reached without cap details says it resets at midnight", () => {
    const copy = describeApiError({ code: "daily_cap_reached", message: "x" });
    expect(copy.message).toContain("resets at midnight");
    expect(copy.message).not.toContain("undefined");
    expect(copy.retryable).toBe(false);
  });

  it("an internal error with an empty message still says something", () => {
    expect(describeApiError({ code: "internal", message: "" }).message).toBe("Please try again.");
  });

  it("no code's copy leaks 'undefined' or 'null'", () => {
    const codes: ApiErrorCode[] = [
      "bad_request",
      "unauthorized",
      "not_invited",
      "not_found",
      "daily_cap_reached",
      "ai_paused",
      "ai_failed",
      "server_misconfigured",
      "not_implemented",
      "internal",
    ];
    for (const code of codes) {
      const copy = describeApiError({ code, message: "m" });
      expect(`${copy.title} ${copy.message}`).not.toMatch(/undefined|null/);
    }
  });
});
