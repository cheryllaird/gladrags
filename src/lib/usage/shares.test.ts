/**
 * Round 2: the outfit preview cap, the image_generation cost and the
 * per-feature monthly spend shares in the usage guard.
 */
import { describe, expect, it } from "vitest";
import { ApiErrorSchema } from "@/contracts";
import { DAILY_CAPS, ESTIMATED_COST_PENCE, MAX_SETTLED_COST_PENCE, MONTHLY_AI_SPEND_CAP_PENCE, MONTHLY_SPEND_SHARES } from "./config";
import { CapReachedError, isAiPausedError } from "./errors";
import { UsageGuard, maxSettledCost, type UsageLimits } from "./guard";
import { InMemoryUsageStore } from "./store";

const ALICE = "0a000000-0000-4000-8000-000000000001";
const BOB = "0b000000-0000-4000-8000-000000000002";

const limits: UsageLimits = {
  dailyCaps: { item_ingest: 5, outfit_request: 5, link_fetch: 5, email_import: 5, shop_search: 5, outfit_preview: 3 },
  monthlySpendCapPence: 100,
  timeZone: "Europe/London",
  spendShares: {
    images: { kinds: ["image_generation"], capPence: 10 },
    shop_search: { kinds: ["shop_grounding"], capPence: 6 },
  },
};

function setup(custom: UsageLimits = limits) {
  const now = () => new Date("2026-11-13T10:00:00Z");
  const store = new InMemoryUsageStore(now);
  return { guard: new UsageGuard(store, custom, now), store };
}

async function capOf(promise: Promise<unknown>): Promise<CapReachedError | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    if (error instanceof CapReachedError) return error;
    throw error;
  }
}

describe("config (round 2)", () => {
  it("12 previews a day, 4p an image settled at most 20p, and 2 pound shares for images and shop search", () => {
    expect(DAILY_CAPS.outfit_preview).toBe(12);
    expect(ESTIMATED_COST_PENCE.image_generation).toBe(4);
    expect(MAX_SETTLED_COST_PENCE.image_generation).toBe(20);
    expect(maxSettledCost("image_generation")).toBe(20);
    expect(maxSettledCost("tagging")).toBeCloseTo(0.6);
    expect(MONTHLY_SPEND_SHARES.images).toEqual({ kinds: ["image_generation"], capPence: 200 });
    expect(MONTHLY_SPEND_SHARES.shop_search).toEqual({ kinds: ["shop_grounding"], capPence: 200 });
    for (const share of Object.values(MONTHLY_SPEND_SHARES)) expect(share.capPence).toBeLessThan(MONTHLY_AI_SPEND_CAP_PENCE);
  });

  it("a full day of previews by one user stays well within the images share at the estimate", () => {
    expect(DAILY_CAPS.outfit_preview * ESTIMATED_COST_PENCE.image_generation).toBeLessThan(MONTHLY_SPEND_SHARES.images.capPence);
  });
});

describe("the outfit preview daily cap", () => {
  it("counts per user and refuses the fourth with outfit_previews_per_day", async () => {
    const { guard } = setup();
    for (let i = 0; i < 3; i++) await guard.reserveAction(ALICE, "outfit_preview");
    const error = await capOf(guard.reserveAction(ALICE, "outfit_preview"));
    expect(error?.cap).toBe("outfit_previews_per_day");
    expect(error?.toApiException().code).toBe("daily_cap_reached");
    await expect(guard.reserveAction(BOB, "outfit_preview")).resolves.toBeDefined();
    expect((await guard.summary(ALICE)).outfitPreviewsToday).toEqual({ used: 3, limit: 3 });
  });
});

describe("monthly spend shares", () => {
  it("image calls stop at the images share (reached, not approached); other AI keeps working", async () => {
    const { guard } = setup();
    for (let i = 0; i < 3; i++) await guard.reserveAiCost(ALICE, "image_generation", "gemini"); // 12p >= 10p
    const error = await capOf(guard.reserveAiCost(ALICE, "image_generation", "gemini"));
    expect(error?.cap).toBe("monthly_image_spend");
    expect(isAiPausedError(error)).toBe(true);
    const api = error!.toApiException();
    expect(api.code).toBe("ai_paused");
    expect(api.extras.cap).toMatchObject({ kind: "monthly_image_spend", limit: 10 });
    await expect(guard.reserveAiCost(ALICE, "tagging", "gemini")).resolves.toBeTypeOf("string");
    await expect(guard.reserveAiCost(ALICE, "shop_grounding", "gemini")).resolves.toBeTypeOf("string");
    await expect(guard.assertCanStart(ALICE, "item_ingest")).resolves.toBeUndefined();
  });

  it("the preview action is refused (before counting) once the images share is spent", async () => {
    const { guard, store } = setup();
    for (let i = 0; i < 3; i++) await guard.reserveAiCost(null, "image_generation");
    expect((await capOf(guard.assertCanStart(ALICE, "outfit_preview")))?.cap).toBe("monthly_image_spend");
    expect((await capOf(guard.reserveAction(ALICE, "outfit_preview")))?.cap).toBe("monthly_image_spend");
    expect(store.events.filter((e) => e.kind === "outfit_preview")).toHaveLength(0);
    const summary = await guard.summary(ALICE);
    expect(summary).toMatchObject({ aiPaused: false, previewsPaused: true, shopSearchPaused: false });
  });

  it("shop search has its own share", async () => {
    const { guard } = setup();
    await guard.reserveAiCost(null, "shop_grounding"); // 3p
    await guard.reserveAiCost(null, "shop_grounding"); // 6p: reached
    expect((await capOf(guard.reserveAction(ALICE, "shop_search")))?.cap).toBe("monthly_shop_search_spend");
    expect((await capOf(guard.reserveAiCost(null, "shop_grounding")))?.cap).toBe("monthly_shop_search_spend");
    await expect(guard.reserveAction(ALICE, "outfit_preview")).resolves.toBeDefined();
    expect(await guard.summary(ALICE)).toMatchObject({ shopSearchPaused: true, previewsPaused: false });
  });

  it("the overall cap still pauses everything, shares included", async () => {
    const { guard } = setup();
    await guard.recordAiCost(null, "ranking_final", 100);
    expect((await capOf(guard.reserveAiCost(null, "image_generation")))?.cap).toBe("monthly_ai_spend");
    expect(await guard.summary(ALICE)).toMatchObject({ aiPaused: true, previewsPaused: true, shopSearchPaused: true });
  });

  it("an image call settles at its real cost, clamped at 20p", async () => {
    const { guard, store } = setup();
    const id = await guard.reserveAiCost(null, "image_generation", "gemini");
    await guard.settleAiCost(id, "image_generation", { costPence: 25, provider: "gemini" });
    expect(store.events.find((e) => e.id === id)?.costPence).toBe(20);
  });

  it("the cap error serialises as the API's error shape", async () => {
    const { guard } = setup();
    for (let i = 0; i < 3; i++) await guard.reserveAiCost(null, "image_generation");
    const error = await capOf(guard.reserveAiCost(null, "image_generation"));
    const api = error!.toApiException();
    const body = { error: { code: api.code, message: api.message, ...api.extras } };
    expect(ApiErrorSchema.safeParse(body).success).toBe(true);
  });
});
