import { describe, expect, it, vi } from "vitest";
import { CapReachedError } from "./errors";
import { MAX_SETTLED_COST_MULTIPLE, UsageGuard, type UsageLimits } from "./guard";
import { InMemoryUsageStore } from "./store";

const ALICE = "0a000000-0000-4000-8000-000000000001";
const BOB = "0b000000-0000-4000-8000-000000000002";

const limits: UsageLimits = {
  dailyCaps: { item_ingest: 2, outfit_request: 1, link_fetch: 2, email_import: 2, shop_search: 2 },
  monthlySpendCapPence: 10,
  timeZone: "Europe/London",
};

function setup(start = "2026-10-21T10:00:00Z") {
  let now = new Date(start);
  const clock = () => now;
  const store = new InMemoryUsageStore(clock);
  const guard = new UsageGuard(store, limits, clock);
  return { guard, store, setNow: (iso: string) => (now = new Date(iso)) };
}

async function capOf(promise: Promise<unknown>) {
  try {
    await promise;
    return null;
  } catch (error) {
    if (error instanceof CapReachedError) return error;
    throw error;
  }
}

describe("UsageGuard daily caps", () => {
  it("allows actions up to the cap, then refuses with the reset time", async () => {
    const { guard } = setup();
    for (let i = 0; i < 2; i++) {
      await guard.assertCanStart(ALICE, "item_ingest");
      await guard.reserveAction(ALICE, "item_ingest");
    }
    const error = await capOf(guard.assertCanStart(ALICE, "item_ingest"));
    expect(error?.cap).toBe("items_per_day");
    expect(error?.limit).toBe(2);
    expect(error?.resetsAt.toISOString()).toBe("2026-10-21T23:00:00.000Z"); // midnight BST
  });

  it("counts each user and each action separately", async () => {
    const { guard } = setup();
    await guard.reserveAction(ALICE, "outfit_request");
    expect(await capOf(guard.assertCanStart(ALICE, "outfit_request"))).not.toBeNull();
    expect(await capOf(guard.assertCanStart(ALICE, "item_ingest"))).toBeNull();
    expect(await capOf(guard.assertCanStart(BOB, "outfit_request"))).toBeNull();
  });

  it("resets at UK midnight", async () => {
    const { guard, setNow } = setup("2026-10-21T22:30:00Z"); // 23:30 BST
    await guard.reserveAction(ALICE, "outfit_request");
    expect(await capOf(guard.assertCanStart(ALICE, "outfit_request"))).not.toBeNull();
    setNow("2026-10-21T23:05:00Z"); // 00:05 BST next day
    expect(await capOf(guard.assertCanStart(ALICE, "outfit_request"))).toBeNull();
  });

  it("maps to a 429 daily_cap_reached API error", async () => {
    const { guard } = setup();
    await guard.reserveAction(ALICE, "outfit_request");
    const error = await capOf(guard.assertCanStart(ALICE, "outfit_request"));
    const api = error!.toApiException();
    expect(api.code).toBe("daily_cap_reached");
    expect(api.extras.cap?.kind).toBe("outfit_requests_per_day");
  });
});

describe("UsageGuard monthly AI spend cap", () => {
  it("pauses AI for everyone once total spend reaches the cap", async () => {
    const { guard } = setup();
    await guard.recordAiCost(ALICE, "ranking_final", 6, "fake");
    expect(await guard.isAiPaused()).toBe(false);
    await guard.recordAiCost(BOB, "tagging", 4, "fake");
    expect(await guard.isAiPaused()).toBe(true);

    const error = await capOf(guard.assertCanStart(ALICE, "item_ingest"));
    expect(error?.cap).toBe("monthly_ai_spend");
    expect(error?.resetsAt.toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(error?.toApiException().code).toBe("ai_paused");
  });

  it("uses the estimated cost when the provider doesn't report one", async () => {
    const { guard, store } = setup();
    await guard.recordAiCost(ALICE, "ranking_final");
    expect(store.events[0]?.costPence).toBeGreaterThan(0);
  });

  it("starts again next month", async () => {
    const { guard, setNow } = setup("2026-10-31T12:00:00Z");
    await guard.recordAiCost(null, "tagging", 50, "fake");
    expect(await guard.isAiPaused()).toBe(true);
    setNow("2026-11-01T00:30:00Z");
    expect(await guard.isAiPaused()).toBe(false);
  });
});

describe("UsageGuard summary", () => {
  it("reports today's counts, limits and pause state", async () => {
    const { guard } = setup();
    await guard.reserveAction(ALICE, "item_ingest");
    expect(await guard.summary(ALICE)).toEqual({
      itemsToday: { used: 1, limit: 2 },
      outfitRequestsToday: { used: 0, limit: 1 },
      emailsToday: { used: 0, limit: 2 },
      shopSearchesToday: { used: 0, limit: 2 },
      dailyResetAt: "2026-10-21T23:00:00.000Z",
      aiPaused: false,
    });
  });
});

describe("UsageGuard settling AI costs", () => {
  it("records a reported cost up to 3x the estimate as reported", async () => {
    const { guard, store } = setup();
    const id = await guard.reserveAiCost(ALICE, "ranking_final", "gemini");
    await guard.settleAiCost(id, "ranking_final", { costPence: 1.5, provider: "gemini" });
    expect(store.events[0]!.costPence).toBe(1.5);
  });

  it("clamps a cost above 3x the estimate, and logs it without user data", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { guard, store } = setup();
    const id = await guard.reserveAiCost(ALICE, "tagging", "gemini");
    await guard.settleAiCost(id, "tagging", { costPence: 7, provider: "gemini" });
    expect(store.events[0]!.costPence).toBeCloseTo(0.6, 10);
    expect(MAX_SETTLED_COST_MULTIPLE).toBe(3);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(ALICE);
    warn.mockRestore();
  });

  it("keeps the estimate when the cost is missing, not finite or negative", async () => {
    const { guard, store } = setup();
    for (const costPence of [undefined, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const id = await guard.reserveAiCost(ALICE, "tagging", "gemini");
      await guard.settleAiCost(id, "tagging", { costPence, provider: "gemini" });
    }
    expect(store.events.map((e) => e.costPence)).toEqual([0.2, 0.2, 0.2, 0.2]);
  });
});
