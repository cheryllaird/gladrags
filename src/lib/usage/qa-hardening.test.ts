/**
 * QA (fix/hardening): atomic caps through UsageGuard, the monthly spend cap
 * under parallel Gemini calls, reservations that never settle, and the UK
 * day/month windows the app hands to reserve_usage.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { callWithValidation } from "@/lib/ai/validate";
import type { ModelCall } from "@/lib/ai/types";
import { DAILY_CAPS, ESTIMATED_COST_PENCE, MONTHLY_AI_SPEND_CAP_PENCE } from "./config";
import { CapReachedError } from "./errors";
import { DEFAULT_USAGE_LIMITS, UsageGuard } from "./guard";
import { InMemoryUsageStore, type UsageReservationRequest } from "./store";
import { startOfDay, startOfMonth } from "./time";

const ALICE = "0a000000-0000-4000-8000-000000000001";
const BOB = "0b000000-0000-4000-8000-000000000002";
const UK = "Europe/London";

function setup(start = "2026-10-26T12:00:00Z") {
  let now = new Date(start);
  const clock = () => now;
  const store = new InMemoryUsageStore(clock);
  const guard = new UsageGuard(store, DEFAULT_USAGE_LIMITS, clock);
  return { guard, store, setNow: (iso: string) => (now = new Date(iso)) };
}

async function settleAll(promises: Promise<unknown>[]) {
  const results = await Promise.allSettled(promises);
  const granted = results.filter((r) => r.status === "fulfilled").length;
  const refused = results.flatMap((r) => (r.status === "rejected" ? [r.reason as unknown] : []));
  return { granted, refused };
}

const spend = (store: InMemoryUsageStore) => store.events.reduce((sum, e) => sum + e.costPence, 0);

/** A store whose reserve() yields to the event loop first, like a network round trip. */
class SlowInMemoryUsageStore extends InMemoryUsageStore {
  override async reserve(request: UsageReservationRequest) {
    await new Promise((resolve) => setTimeout(resolve, Math.random() * 5));
    return super.reserve(request);
  }
}

describe("daily caps under a burst of parallel reservations (real cap values)", () => {
  for (const action of ["item_ingest", "outfit_request", "link_fetch"] as const) {
    it(`${action}: ${DAILY_CAPS[action] + 30} at once grants exactly ${DAILY_CAPS[action]}`, async () => {
      const { guard, store } = setup();
      const { granted, refused } = await settleAll(Array.from({ length: DAILY_CAPS[action] + 30 }, () => guard.reserveAction(ALICE, action)));
      expect(granted).toBe(DAILY_CAPS[action]);
      expect(refused).toHaveLength(30);
      expect(refused.every((e) => e instanceof CapReachedError && e.limit === DAILY_CAPS[action])).toBe(true);
      expect(store.events.filter((e) => e.kind === action)).toHaveLength(DAILY_CAPS[action]);
    });
  }

  it("a slow store (a yield before each reserve) still can't overshoot", async () => {
    const store = new SlowInMemoryUsageStore();
    const guard = new UsageGuard(store);
    const { granted } = await settleAll(Array.from({ length: 100 }, () => guard.reserveAction(ALICE, "link_fetch")));
    expect(granted).toBe(DAILY_CAPS.link_fetch);
  });

  it("assertCanStart + reserveAction in parallel (the routes' pattern): passing the check doesn't guarantee a place", async () => {
    const { guard, store } = setup();
    const attempt = async () => {
      await guard.assertCanStart(ALICE, "item_ingest");
      await guard.reserveAction(ALICE, "item_ingest");
    };
    const { granted } = await settleAll(Array.from({ length: 60 }, attempt));
    expect(granted).toBe(DAILY_CAPS.item_ingest);
    expect(store.events).toHaveLength(DAILY_CAPS.item_ingest);
  });

  it("two users bursting at once each get their own full allowance", async () => {
    const { guard, store } = setup();
    const calls = Array.from({ length: 50 }, (_, i) => guard.reserveAction(i % 2 ? ALICE : BOB, "outfit_request"));
    const { granted } = await settleAll(calls);
    expect(granted).toBe(2 * 25);
    expect(store.events.filter((e) => e.userId === ALICE)).toHaveLength(25);
    expect(store.events.filter((e) => e.userId === BOB)).toHaveLength(25);
  });

  it("the link_fetch cap is separate from the item cap, both ways", async () => {
    const { guard } = setup();
    await settleAll(Array.from({ length: DAILY_CAPS.link_fetch }, () => guard.reserveAction(ALICE, "link_fetch")));
    await expect(guard.reserveAction(ALICE, "item_ingest")).resolves.toBeDefined();
    const error = await guard.reserveAction(ALICE, "link_fetch").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CapReachedError);
    expect((error as CapReachedError).cap).toBe("link_fetches_per_day");
    const api = (error as CapReachedError).toApiException();
    expect(api.code).toBe("daily_cap_reached");
    expect(api.extras).toMatchObject({ cap: { kind: "link_fetches_per_day", limit: 80 } });
  });

  it("a cancelled reservation frees exactly one place, even under a burst", async () => {
    const { guard } = setup();
    const reservations = await Promise.all(Array.from({ length: 40 }, () => guard.reserveAction(ALICE, "item_ingest")));
    await reservations[0]!.cancel();
    const { granted } = await settleAll(Array.from({ length: 10 }, () => guard.reserveAction(ALICE, "item_ingest")));
    expect(granted).toBe(1);
  });

  it("cancelling twice gives back only one place", async () => {
    const { guard, store } = setup();
    const reservations = await Promise.all(Array.from({ length: 40 }, () => guard.reserveAction(ALICE, "item_ingest")));
    await reservations[5]!.cancel();
    await reservations[5]!.cancel();
    expect(store.events).toHaveLength(39);
  });
});

describe("monthly spend cap under parallel Gemini calls", () => {
  it("from just under £5, 200 parallel final picks grant exactly one: overshoot is under one call's estimate", async () => {
    const { guard, store } = setup();
    await store.record({ userId: null, kind: "tagging", costPence: MONTHLY_AI_SPEND_CAP_PENCE - 0.01, provider: "gemini" });
    const { granted, refused } = await settleAll(Array.from({ length: 200 }, () => guard.reserveAiCost(ALICE, "ranking_final", "gemini")));
    expect(granted).toBe(1);
    expect(refused.every((e) => e instanceof CapReachedError && e.cap === "monthly_ai_spend")).toBe(true);
    expect(spend(store) - MONTHLY_AI_SPEND_CAP_PENCE).toBeLessThan(ESTIMATED_COST_PENCE.ranking_final);
  });

  it("from zero, a burst of 3,000 mixed calls stops at the cap; overshoot < the largest estimate (0.5p)", async () => {
    const { guard, store } = setup();
    const kinds = ["tagging", "ranking_shortlist", "ranking_final"] as const;
    const { granted } = await settleAll(Array.from({ length: 3000 }, (_, i) => guard.reserveAiCost(i % 2 ? ALICE : BOB, kinds[i % 3]!, "gemini")));
    expect(granted).toBeGreaterThan(0);
    const total = spend(store);
    expect(total).toBeGreaterThanOrEqual(MONTHLY_AI_SPEND_CAP_PENCE);
    expect(total - MONTHLY_AI_SPEND_CAP_PENCE).toBeLessThan(0.5);
    await expect(guard.isAiPaused()).resolves.toBe(true);
  });

  it("MEASURED: in-flight calls that settle above the estimate push past the cap by (real - estimate) each", async () => {
    // Pins the documented "a real cost above the estimate can add a little
    // more". With N calls in flight when the cap is crossed, the overshoot
    // is the sum of their excess over the estimate: not bounded by 0.5p.
    const { guard, store } = setup();
    await store.record({ userId: null, kind: "tagging", costPence: 498, provider: "gemini" });
    const meters = Array.from({ length: 30 }, () => guard.meterAiCalls(ALICE, "tagging", "gemini"));
    const results = await Promise.allSettled(meters.map((m) => m.beforeCall()));
    const granted = meters.filter((_, i) => results[i]!.status === "fulfilled");
    // 498p + 0.2p each: 10 reservations fit before 500p is reached.
    expect(granted).toHaveLength(10);
    // Every granted call then reports a real cost of 1p (5x the estimate).
    await Promise.all(granted.map((m) => m.onCall({ costPence: 1, provider: "gemini" })));
    const overshoot = spend(store) - MONTHLY_AI_SPEND_CAP_PENCE;
    expect(overshoot).toBeCloseTo(8, 5);
    await expect(guard.reserveAiCost(ALICE, "tagging")).rejects.toBeInstanceOf(CapReachedError);
  });
});

describe("reservations that never settle keep the estimate", () => {
  const Schema = z.object({ ok: z.literal(true) });
  const valid: ModelCall = { raw: JSON.stringify({ ok: true }), costPence: 0.05, provider: "gemini", model: "m" };

  it("a provider that throws on both attempts: two rows, each at the estimate, with the provider's name", async () => {
    const { guard, store } = setup();
    const result = await callWithValidation(Schema, async () => Promise.reject(new Error("socket hang up")), {
      ...guard.meterAiCalls(ALICE, "tagging", "gemini"),
      provider: "gemini",
    });
    expect(result.ok).toBe(false);
    expect(store.events.map((e) => [e.kind, e.costPence, e.provider])).toEqual([
      ["tagging", ESTIMATED_COST_PENCE.tagging, "gemini"],
      ["tagging", ESTIMATED_COST_PENCE.tagging, "gemini"],
    ]);
  });

  it("an aborted call (AbortError, the SDK's timeout) keeps the estimate", async () => {
    const { guard, store } = setup();
    const abort = () => Promise.reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }));
    await callWithValidation(Schema, abort, { ...guard.meterAiCalls(ALICE, "ranking_final", "gemini"), provider: "gemini", maxAttempts: 1 });
    expect(store.events).toHaveLength(1);
    expect(store.events[0]!.costPence).toBe(ESTIMATED_COST_PENCE.ranking_final);
  });

  it("a call that never returns (request killed at maxDuration): the estimate is already reserved and stays", async () => {
    const { guard, store } = setup();
    void callWithValidation(Schema, () => new Promise<ModelCall>(() => {}), { ...guard.meterAiCalls(ALICE, "ranking_shortlist") });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(store.events).toHaveLength(1);
    expect(store.events[0]).toMatchObject({ kind: "ranking_shortlist", costPence: ESTIMATED_COST_PENCE.ranking_shortlist });
    await expect(guard.isAiPaused()).resolves.toBe(false);
  });

  it("a hanging call still counts against the cap for everyone else", async () => {
    const { guard, store } = setup();
    await store.record({ userId: null, kind: "tagging", costPence: MONTHLY_AI_SPEND_CAP_PENCE - 0.1, provider: "gemini" });
    void callWithValidation(Schema, () => new Promise<ModelCall>(() => {}), { ...guard.meterAiCalls(ALICE, "tagging") });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await expect(guard.reserveAiCost(BOB, "tagging")).rejects.toBeInstanceOf(CapReachedError);
  });

  it("a successful call settles to its real cost, replacing the estimate (not adding to it)", async () => {
    const { guard, store } = setup();
    const result = await callWithValidation(Schema, async () => valid, { ...guard.meterAiCalls(ALICE, "tagging", "gemini") });
    expect(result.ok).toBe(true);
    expect(store.events).toHaveLength(1);
    expect(store.events[0]!.costPence).toBe(0.05);
  });

  it("the cap reached between attempts: the retry is refused (ai_paused), no second call is made", async () => {
    const { guard, store } = setup();
    let calls = 0;
    const bad = async (): Promise<ModelCall> => {
      calls++;
      // While the first attempt runs, someone else uses up the month.
      await store.record({ userId: null, kind: "tagging", costPence: MONTHLY_AI_SPEND_CAP_PENCE, provider: "gemini" });
      return { raw: "not json", costPence: 0.1, provider: "gemini", model: "m" };
    };
    await expect(callWithValidation(Schema, bad, { ...guard.meterAiCalls(ALICE, "tagging", "gemini") })).rejects.toBeInstanceOf(CapReachedError);
    expect(calls).toBe(1);
    expect(store.events.filter((e) => e.kind === "tagging" && e.userId === ALICE)).toHaveLength(1);
  });

  it("if settling fails (database down), the estimate stands and the error surfaces", async () => {
    const { guard, store } = setup();
    store.settle = async () => {
      throw new Error("Couldn't settle usage: db down");
    };
    await expect(callWithValidation(Schema, async () => valid, { ...guard.meterAiCalls(ALICE, "tagging") })).rejects.toThrow(/settle/);
    expect(store.events[0]!.costPence).toBe(ESTIMATED_COST_PENCE.tagging);
  });

  // FINDING (low): the provider's reported cost is not validated before it
  // reaches the store. The in-memory store (mock mode, tests) accepts NaN,
  // which makes the month's total NaN and silently disables the £5 cap;
  // Postgres would refuse NaN (sent as JSON null) and negatives (check
  // constraint), so settle throws and the request fails after a paid call.
  it("FINDING: a NaN cost reported by a provider disables the in-memory spend cap", async () => {
    const { guard, store } = setup();
    await store.record({ userId: null, kind: "tagging", costPence: MONTHLY_AI_SPEND_CAP_PENCE, provider: "gemini" });
    await expect(guard.isAiPaused()).resolves.toBe(true);
    // A call made before the pause settles with costPence NaN.
    const meter = guard.meterAiCalls(ALICE, "tagging");
    store.events.splice(0, 1); // (reserve while under the cap...)
    await meter.beforeCall();
    await store.record({ userId: null, kind: "tagging", costPence: MONTHLY_AI_SPEND_CAP_PENCE, provider: "gemini" });
    await meter.onCall({ costPence: Number.NaN, provider: "gemini" });
    expect(await guard.isAiPaused()).toBe(false); // the cap is gone
    await expect(guard.reserveAiCost(BOB, "tagging")).resolves.toEqual(expect.any(String));
  });

  it("FINDING: a negative cost is accepted and lowers the month's spend (in memory)", async () => {
    const { guard, store } = setup();
    await store.record({ userId: null, kind: "tagging", costPence: MONTHLY_AI_SPEND_CAP_PENCE, provider: "gemini" });
    await guard.recordAiCost(ALICE, "tagging", -10, "gemini");
    expect(await guard.isAiPaused()).toBe(false);
  });
});

describe("the UK windows passed to reserve_usage always pass its sanity checks", () => {
  // reserve_usage refuses (raises) a day start outside [now - 25h 1m,
  // now + 1m] and a month start outside [now - 31d 1h 1m, now + 1m]. Walk
  // every 15 minutes of 2026 and 2027, both clock changes included.
  const DAY_MAX_MS = (25 * 60 + 1) * 60_000;
  const MONTH_MAX_MS = (31 * 24 * 60 + 61) * 60_000;

  it("every instant's day start is within 25 hours and its month start within 31 days 1 hour", { timeout: 120_000 }, () => {
    const bad: string[] = [];
    const instants: number[] = [];
    // Every hour of 2026 and 2027, plus every minute of the four clock-change days.
    for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2028, 0, 1); t += 60 * 60_000) instants.push(t);
    for (const day of ["2026-03-29", "2026-10-25", "2027-03-28", "2027-10-31"]) {
      const start = Date.parse(`${day}T00:00:00Z`) - 60 * 60_000;
      for (let t = start; t < start + 26 * 60 * 60_000; t += 60_000) instants.push(t);
    }
    for (const t of instants) {
      const now = new Date(t);
      const day = now.getTime() - startOfDay(now, UK).getTime();
      const month = now.getTime() - startOfMonth(now, UK).getTime();
      if (day < 0 || day > DAY_MAX_MS || month < 0 || month > MONTH_MAX_MS) bad.push(now.toISOString());
    }
    expect(bad).toEqual([]);
  });

  it("the last second of the 25-hour day (25 October 2026, 23:59:59 GMT) is still inside the day window", () => {
    const now = new Date("2026-10-25T23:59:59Z");
    const start = startOfDay(now, UK);
    expect(start.toISOString()).toBe("2026-10-24T23:00:00.000Z");
    expect(now.getTime() - start.getTime()).toBeLessThanOrEqual(DAY_MAX_MS);
  });

  it("reserveAction passes the store the UK day start and, for AI actions, the month start", async () => {
    const seen: UsageReservationRequest[] = [];
    let now = new Date("2026-03-29T00:30:00Z"); // 00:30 GMT, half an hour before the clocks go forward
    const store = new InMemoryUsageStore(() => now);
    const original = store.reserve.bind(store);
    store.reserve = async (request) => {
      seen.push(request);
      return original(request);
    };
    const guard = new UsageGuard(store, DEFAULT_USAGE_LIMITS, () => now);
    await guard.reserveAction(ALICE, "item_ingest");
    now = new Date("2026-03-29T22:59:00Z"); // 23:59 BST, the same UK day
    await guard.reserveAction(ALICE, "link_fetch");
    expect(seen[0]).toMatchObject({ dayStart: new Date("2026-03-29T00:00:00Z"), monthStart: new Date("2026-03-01T00:00:00Z"), monthlyCapPence: 500 });
    expect(seen[1]).toMatchObject({ dayStart: new Date("2026-03-29T00:00:00Z"), monthStart: null, monthlyCapPence: null });
  });

  it("a burst straddling UK midnight in BST: yesterday's full allowance doesn't block today", async () => {
    const { guard, setNow } = setup("2026-07-14T22:59:30Z"); // 23:59:30 BST
    await settleAll(Array.from({ length: 25 }, () => guard.reserveAction(ALICE, "outfit_request")));
    await expect(guard.reserveAction(ALICE, "outfit_request")).rejects.toBeInstanceOf(CapReachedError);
    setNow("2026-07-14T23:00:00Z"); // 00:00 BST on the 15th
    const { granted } = await settleAll(Array.from({ length: 30 }, () => guard.reserveAction(ALICE, "outfit_request")));
    expect(granted).toBe(25);
  });

  it("a burst straddling the month boundary in BST: last month's spend no longer pauses AI", async () => {
    const { guard, store, setNow } = setup("2026-09-30T22:30:00Z"); // 23:30 BST, 30 September
    await store.record({ userId: null, kind: "tagging", costPence: MONTHLY_AI_SPEND_CAP_PENCE, provider: "gemini" });
    await expect(guard.reserveAiCost(ALICE, "tagging")).rejects.toBeInstanceOf(CapReachedError);
    setNow("2026-09-30T23:00:00Z"); // 00:00 BST, 1 October
    await expect(guard.reserveAiCost(ALICE, "tagging")).resolves.toEqual(expect.any(String));
  });
});
