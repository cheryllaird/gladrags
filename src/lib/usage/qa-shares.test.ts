/**
 * QA (round 2, P1): the monthly spend shares with the real config (£2 for
 * images, £2 for shop search, £5 overall): each share pauses only its own
 * feature at exactly its cap, the £5 still pauses everything, bursts
 * can't overshoot, and callers that predate shares see no change.
 */
import { describe, expect, it } from "vitest";
import { CapReachedError } from "./errors";
import { ESTIMATED_COST_PENCE, MONTHLY_AI_SPEND_CAP_PENCE, MONTHLY_SPEND_SHARES } from "./config";
import { DEFAULT_USAGE_LIMITS, UsageGuard, type UsageLimits } from "./guard";
import { InMemoryUsageStore, type UsageReservationRequest } from "./store";

const ALICE = "0a000000-0000-4000-8000-000000000001";
const BOB = "0b000000-0000-4000-8000-000000000002";
const NOW = new Date("2026-11-13T10:00:00Z");

function setup(limits: UsageLimits = DEFAULT_USAGE_LIMITS) {
  const store = new InMemoryUsageStore(() => NOW);
  return { guard: new UsageGuard(store, limits, () => NOW), store };
}

async function capOf(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    if (error instanceof CapReachedError) return error.cap;
    throw error;
  }
}

describe("QA: the images share at £2", () => {
  it("199.99p of images still allows one more; 200p pauses images and nothing else", async () => {
    const { guard } = setup();
    await guard.recordAiCost(null, "image_generation", 199.99);
    await expect(guard.reserveAction(ALICE, "outfit_preview")).resolves.toBeDefined();
    await expect(guard.reserveAiCost(ALICE, "image_generation")).resolves.toBeTypeOf("string"); // now 207.99p
    expect(await capOf(guard.reserveAiCost(ALICE, "image_generation"))).toBe("monthly_image_spend");
    expect(await capOf(guard.reserveAction(BOB, "outfit_preview"))).toBe("monthly_image_spend");
    expect(await capOf(guard.assertCanStart(BOB, "outfit_preview"))).toBe("monthly_image_spend");

    for (const kind of ["tagging", "ranking_shortlist", "ranking_final", "email_extraction", "shop_grounding"] as const) {
      await expect(guard.reserveAiCost(ALICE, kind)).resolves.toBeTypeOf("string");
    }
    for (const action of ["item_ingest", "outfit_request", "link_fetch", "email_import", "shop_search"] as const) {
      await expect(guard.assertCanStart(ALICE, action)).resolves.toBeUndefined();
    }
    expect(await guard.summary(ALICE)).toMatchObject({ aiPaused: false, previewsPaused: true, shopSearchPaused: false });
  });

  it("spend of other kinds never counts towards the images share", async () => {
    const { guard } = setup();
    await guard.recordAiCost(null, "ranking_final", 450);
    await expect(guard.reserveAiCost(ALICE, "image_generation")).resolves.toBeTypeOf("string");
    expect((await guard.summary(ALICE)).previewsPaused).toBe(false);
  });

  it("the share is everyone's: Bob's pictures pause Alice's", async () => {
    const { guard } = setup();
    await guard.recordAiCost(BOB, "image_generation", 200);
    expect(await capOf(guard.reserveAiCost(ALICE, "image_generation"))).toBe("monthly_image_spend");
  });

  it("last month's image spend doesn't count", async () => {
    const store = new InMemoryUsageStore(() => NOW);
    store.events.push({ id: crypto.randomUUID(), userId: null, kind: "image_generation", costPence: 500, provider: "gemini", at: new Date("2026-10-31T12:00:00Z") });
    const guard = new UsageGuard(store, DEFAULT_USAGE_LIMITS, () => NOW);
    await expect(guard.reserveAiCost(ALICE, "image_generation")).resolves.toBeTypeOf("string");
  });
});

describe("QA: the shop search share at £2", () => {
  it("pauses shop search (the action and the grounding call) and nothing else", async () => {
    const { guard } = setup();
    await guard.recordAiCost(null, "shop_grounding", 200);
    expect(await capOf(guard.assertCanStart(ALICE, "shop_search"))).toBe("monthly_shop_search_spend");
    expect(await capOf(guard.reserveAction(ALICE, "shop_search"))).toBe("monthly_shop_search_spend");
    expect(await capOf(guard.reserveAiCost(ALICE, "shop_grounding"))).toBe("monthly_shop_search_spend");
    await expect(guard.reserveAction(ALICE, "outfit_preview")).resolves.toBeDefined();
    await expect(guard.reserveAiCost(ALICE, "image_generation")).resolves.toBeTypeOf("string");
    await expect(guard.reserveAiCost(ALICE, "tagging")).resolves.toBeTypeOf("string");
    expect(await guard.summary(ALICE)).toMatchObject({ aiPaused: false, previewsPaused: false, shopSearchPaused: true });
  });

  it("with both shares spent (£4), tagging and outfits still have the last £1", async () => {
    const { guard } = setup();
    await guard.recordAiCost(null, "shop_grounding", 200);
    await guard.recordAiCost(null, "image_generation", 200);
    let granted = 0;
    while ((await capOf(guard.reserveAiCost(ALICE, "ranking_final"))) === null) granted++;
    expect(granted).toBe(200); // 100p at 0.5p a call
    expect(await capOf(guard.reserveAiCost(ALICE, "tagging"))).toBe("monthly_ai_spend");
  });
});

describe("QA: the overall £5 still pauses everything", () => {
  it("with both shares unspent, the overall cap refuses images and shop search as monthly_ai_spend", async () => {
    const { guard } = setup();
    await guard.recordAiCost(null, "tagging", MONTHLY_AI_SPEND_CAP_PENCE);
    expect(await capOf(guard.reserveAiCost(ALICE, "image_generation"))).toBe("monthly_ai_spend");
    expect(await capOf(guard.reserveAiCost(ALICE, "shop_grounding"))).toBe("monthly_ai_spend");
    expect(await capOf(guard.reserveAction(ALICE, "outfit_preview"))).toBe("monthly_ai_spend");
    expect(await capOf(guard.assertCanStart(ALICE, "outfit_preview"))).toBe("monthly_ai_spend");
    expect(await capOf(guard.reserveAction(ALICE, "shop_search"))).toBe("monthly_ai_spend");
    expect(await guard.summary(ALICE)).toMatchObject({ aiPaused: true, previewsPaused: true, shopSearchPaused: true });
  });

  it("with the images share also spent, the overall pause is what's reported", async () => {
    const { guard } = setup();
    await guard.recordAiCost(null, "image_generation", 200);
    await guard.recordAiCost(null, "tagging", 300);
    expect(await capOf(guard.reserveAiCost(ALICE, "image_generation"))).toBe("monthly_ai_spend");
    expect(await capOf(guard.assertCanStart(ALICE, "outfit_preview"))).toBe("monthly_ai_spend");
  });

  it("the daily preview cap is reported only while spend allows", async () => {
    const { guard } = setup();
    for (let i = 0; i < 12; i++) await guard.reserveAction(ALICE, "outfit_preview");
    expect(await capOf(guard.reserveAction(ALICE, "outfit_preview"))).toBe("outfit_previews_per_day");
    await guard.recordAiCost(null, "image_generation", 200);
    expect(await capOf(guard.reserveAction(ALICE, "outfit_preview"))).toBe("monthly_image_spend");
  });
});

describe("QA: bursts", () => {
  it("100 image reservations at once stop at the share: exactly 25 at 8p under £2", async () => {
    const { guard, store } = setup();
    const results = await Promise.all(Array.from({ length: 100 }, () => capOf(guard.reserveAiCost(ALICE, "image_generation"))));
    expect(results.filter((r) => r === null)).toHaveLength(MONTHLY_SPEND_SHARES.images.capPence / ESTIMATED_COST_PENCE.image_generation);
    expect(results.filter((r) => r === "monthly_image_spend")).toHaveLength(75);
    expect(await store.spendSince(new Date("2026-11-01T00:00:00Z"), ["image_generation"])).toBe(200);
  });

  it("a mixed burst (images, shop grounding, tagging) keeps each share and the overall cap", async () => {
    const limits: UsageLimits = {
      ...DEFAULT_USAGE_LIMITS,
      monthlySpendCapPence: 30,
      spendShares: { images: { kinds: ["image_generation"], capPence: 16 }, shop_search: { kinds: ["shop_grounding"], capPence: 9 } },
    };
    const { guard, store } = setup(limits);
    const kinds = ["image_generation", "shop_grounding", "tagging"] as const;
    await Promise.all(Array.from({ length: 300 }, (_, i) => capOf(guard.reserveAiCost(BOB, kinds[i % 3]!))));
    const since = new Date("2026-11-01T00:00:00Z");
    expect(await store.spendSince(since, ["image_generation"])).toBe(16); // two 8p images (share 16p, a multiple of the 8p estimate)
    expect(await store.spendSince(since, ["shop_grounding"])).toBe(9);
    // Overall: the last call starts below 30p, so the month ends at most one call over.
    const total = await store.spendSince(since);
    expect(total).toBeGreaterThanOrEqual(30);
    expect(total).toBeLessThan(30 + ESTIMATED_COST_PENCE.image_generation);
  });

  it("a burst of preview actions by one user gives exactly 12", async () => {
    const { guard } = setup();
    const results = await Promise.all(Array.from({ length: 40 }, () => capOf(guard.reserveAction(ALICE, "outfit_preview"))));
    expect(results.filter((r) => r === null)).toHaveLength(12);
  });
});

describe("QA: callers that predate shares", () => {
  /** A store that records what each reservation asked for. */
  function spyingStore() {
    const store = new InMemoryUsageStore(() => NOW);
    const requests: UsageReservationRequest[] = [];
    const reserve = store.reserve.bind(store);
    store.reserve = async (request) => {
      requests.push(request);
      return reserve(request);
    };
    return { store, requests };
  }

  it("kinds and actions without a share send no share (null kinds, null cap)", async () => {
    const { store, requests } = spyingStore();
    const guard = new UsageGuard(store, DEFAULT_USAGE_LIMITS, () => NOW);
    for (const action of ["item_ingest", "outfit_request", "link_fetch", "email_import"] as const) await guard.reserveAction(ALICE, action);
    for (const kind of ["tagging", "ranking_shortlist", "ranking_final", "email_extraction"] as const) await guard.reserveAiCost(ALICE, kind);
    expect(requests).toHaveLength(8);
    for (const r of requests) expect(r).toMatchObject({ shareKinds: null, shareCapPence: null });
  });

  it("image and shop kinds send their share", async () => {
    const { store, requests } = spyingStore();
    const guard = new UsageGuard(store, DEFAULT_USAGE_LIMITS, () => NOW);
    await guard.reserveAction(ALICE, "outfit_preview");
    await guard.reserveAiCost(ALICE, "image_generation");
    await guard.reserveAction(ALICE, "shop_search");
    await guard.reserveAiCost(ALICE, "shop_grounding");
    expect(requests.map((r) => [r.kind, r.shareKinds, r.shareCapPence])).toEqual([
      ["outfit_preview", ["image_generation"], 200],
      ["image_generation", ["image_generation"], 200],
      ["shop_search", ["shop_grounding"], 200],
      ["shop_grounding", ["shop_grounding"], 200],
    ]);
    // The preview action is a count, not a cost, and still checks the month.
    expect(requests[0]).toMatchObject({ costPence: 0, monthStart: expect.any(Date), monthlyCapPence: MONTHLY_AI_SPEND_CAP_PENCE });
  });

  it("a guard built with limits that have no shares falls back to the defaults", async () => {
    const { spendShares: _none, ...withoutShares } = DEFAULT_USAGE_LIMITS;
    const { guard } = setup(withoutShares);
    await guard.recordAiCost(null, "image_generation", 200);
    expect(await capOf(guard.reserveAiCost(ALICE, "image_generation"))).toBe("monthly_image_spend");
  });

  it("the in-memory store refuses a share without kinds (as the SQL does)", async () => {
    const store = new InMemoryUsageStore(() => NOW);
    await expect(
      store.reserve({
        userId: null,
        kind: "image_generation",
        costPence: 4,
        provider: null,
        dailyLimit: null,
        dayStart: null,
        monthlyCapPence: null,
        monthStart: NOW,
        shareKinds: [],
        shareCapPence: 10,
      }),
    ).rejects.toThrow();
  });
});
