/**
 * QA gap tests for the usage guard (spec: Cost controls). Uses the real cap
 * values from config.ts so a change to them is caught, and walks the UK day
 * and month boundaries through both clock changes.
 */
import { describe, expect, it } from "vitest";
import { DAILY_CAPS, ESTIMATED_COST_PENCE, MONTHLY_AI_SPEND_CAP_PENCE, USAGE_TIME_ZONE } from "./config";
import { CapReachedError } from "./errors";
import { DEFAULT_USAGE_LIMITS, UsageGuard } from "./guard";
import { InMemoryUsageStore } from "./store";
import { startOfDay, startOfMonth, startOfNextDay, startOfNextMonth } from "./time";

const ALICE = "0a000000-0000-4000-8000-000000000001";
const BOB = "0b000000-0000-4000-8000-000000000002";
const UK = "Europe/London";

function setup(start: string) {
  let now = new Date(start);
  const clock = () => now;
  const store = new InMemoryUsageStore(clock);
  const guard = new UsageGuard(store, DEFAULT_USAGE_LIMITS, clock);
  return { guard, store, setNow: (iso: string) => (now = new Date(iso)) };
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

describe("configured caps match CONTRACTS.md section 7", () => {
  it("is 40 items, 25 outfit requests, 80 link fetches, £5 a month, UK time", () => {
    expect(DAILY_CAPS).toEqual({ item_ingest: 40, outfit_request: 25, link_fetch: 80 });
    expect(MONTHLY_AI_SPEND_CAP_PENCE).toBe(500);
    expect(USAGE_TIME_ZONE).toBe(UK);
    expect(ESTIMATED_COST_PENCE).toEqual({ tagging: 0.2, ranking_shortlist: 0.2, ranking_final: 0.5 });
  });
});

describe("daily caps at the boundary (real values)", () => {
  it.each([
    ["item_ingest", DAILY_CAPS.item_ingest, "items_per_day"],
    ["outfit_request", DAILY_CAPS.outfit_request, "outfit_requests_per_day"],
  ] as const)("allows exactly %s x%i, then refuses the next with %s", async (action, limit, kind) => {
    const { guard } = setup("2026-10-21T10:00:00Z");
    for (let i = 0; i < limit - 1; i++) await guard.reserveAction(ALICE, action);
    // limit - 1 used: the last allowed one still goes through.
    expect(await capOf(guard.assertCanStart(ALICE, action))).toBeNull();
    await guard.reserveAction(ALICE, action);
    const error = await capOf(guard.assertCanStart(ALICE, action));
    expect(error?.cap).toBe(kind);
    expect(error?.limit).toBe(limit);
    const api = error!.toApiException();
    expect(api.code).toBe("daily_cap_reached");
    expect(api.extras.cap).toEqual({ kind, limit, resetsAt: "2026-10-21T23:00:00.000Z" });
    expect(api.message).toContain(String(limit));
  });

  it("does not count AI cost events towards the daily caps", async () => {
    const { guard } = setup("2026-10-21T10:00:00Z");
    for (let i = 0; i < 100; i++) await guard.recordAiCost(ALICE, "tagging", 0);
    expect(await capOf(guard.assertCanStart(ALICE, "item_ingest"))).toBeNull();
  });

  // Was pinned with it.fails: check and record were separate calls, so
  // requests that arrived together all passed the check. Fixed by
  // reserveAction (atomic; reserve_usage in SQL, proven in db:verify).
  it("doesn't let simultaneous requests overshoot the cap", async () => {
    const { guard } = setup("2026-10-21T10:00:00Z");
    for (let i = 0; i < DAILY_CAPS.item_ingest - 1; i++) await guard.reserveAction(ALICE, "item_ingest");
    const attempt = async () => {
      await guard.assertCanStart(ALICE, "item_ingest");
      await guard.reserveAction(ALICE, "item_ingest");
    };
    const results = await Promise.allSettled([attempt(), attempt(), attempt()]);
    expect((await guard.summary(ALICE)).itemsToday.used).toBe(DAILY_CAPS.item_ingest);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) if (r.status === "rejected") expect((r.reason as CapReachedError).cap).toBe("items_per_day");
  });

  it("doesn't let simultaneous AI calls overshoot the monthly cap", async () => {
    const { guard, store } = setup("2026-10-21T10:00:00Z");
    await guard.recordAiCost(BOB, "tagging", MONTHLY_AI_SPEND_CAP_PENCE - 0.5);
    // 0.2p each: the first three take the month from 499.5p to 500.1p
    // (reached, not approached); the rest are refused.
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => guard.reserveAiCost(ALICE, "tagging", "gemini")));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    expect(store.events.filter((e) => e.userId === ALICE)).toHaveLength(3);
    expect(await guard.isAiPaused()).toBe(true);
  });

  it("a cancelled reservation gives the place back", async () => {
    const { guard } = setup("2026-10-21T10:00:00Z");
    for (let i = 0; i < DAILY_CAPS.item_ingest - 1; i++) await guard.reserveAction(ALICE, "item_ingest");
    const last = await guard.reserveAction(ALICE, "item_ingest");
    expect((await capOf(guard.reserveAction(ALICE, "item_ingest")))?.cap).toBe("items_per_day");
    await last.cancel();
    expect(await capOf(guard.reserveAction(ALICE, "item_ingest"))).toBeNull();
  });

  it("reserving an item while AI is paused is refused and records nothing", async () => {
    const { guard, store } = setup("2026-10-21T10:00:00Z");
    await guard.recordAiCost(BOB, "tagging", MONTHLY_AI_SPEND_CAP_PENCE);
    const before = store.events.length;
    expect((await capOf(guard.reserveAction(ALICE, "item_ingest")))?.cap).toBe("monthly_ai_spend");
    expect(store.events).toHaveLength(before);
  });

  it("link fetches have their own cap and aren't stopped by the AI pause", async () => {
    const { guard } = setup("2026-10-21T10:00:00Z");
    await guard.recordAiCost(BOB, "tagging", MONTHLY_AI_SPEND_CAP_PENCE);
    for (let i = 0; i < DAILY_CAPS.link_fetch; i++) await guard.reserveAction(ALICE, "link_fetch");
    const error = await capOf(guard.reserveAction(ALICE, "link_fetch"));
    expect(error?.cap).toBe("link_fetches_per_day");
    expect(error?.toApiException().extras.cap).toEqual({ kind: "link_fetches_per_day", limit: 80, resetsAt: "2026-10-21T23:00:00.000Z" });
    // Doesn't touch the item counter /api/usage shows.
    expect((await guard.summary(ALICE)).itemsToday.used).toBe(0);
  });

  it("checking alone never uses up the allowance", async () => {
    const { guard } = setup("2026-10-21T10:00:00Z");
    for (let i = 0; i < 100; i++) await guard.assertCanStart(ALICE, "outfit_request");
    expect((await guard.summary(ALICE)).outfitRequestsToday.used).toBe(0);
  });
});

describe("UK day boundaries through the clock changes", () => {
  it("spring forward (29 March 2026): the day starts at 00:00 GMT and ends at 23:00 UTC", () => {
    const now = new Date("2026-03-29T12:00:00Z");
    expect(startOfDay(now, UK).toISOString()).toBe("2026-03-29T00:00:00.000Z");
    expect(startOfNextDay(now, UK).toISOString()).toBe("2026-03-29T23:00:00.000Z");
  });

  it("spring forward: just before and just after the 01:00 UTC jump are the same UK day", () => {
    expect(startOfDay(new Date("2026-03-29T00:59:59Z"), UK).toISOString()).toBe("2026-03-29T00:00:00.000Z");
    expect(startOfDay(new Date("2026-03-29T01:00:01Z"), UK).toISOString()).toBe("2026-03-29T00:00:00.000Z");
  });

  it("fall back (25 October 2026): 23:30 UTC on the 25th is still the 25th in the UK", () => {
    const now = new Date("2026-10-25T23:30:00Z");
    expect(startOfDay(now, UK).toISOString()).toBe("2026-10-24T23:00:00.000Z");
    expect(startOfNextDay(now, UK).toISOString()).toBe("2026-10-26T00:00:00.000Z");
  });

  it("fall back: both 01:30 local times (BST, then GMT) are the same UK day", () => {
    expect(startOfDay(new Date("2026-10-25T00:30:00Z"), UK).toISOString()).toBe("2026-10-24T23:00:00.000Z");
    expect(startOfDay(new Date("2026-10-25T01:30:00Z"), UK).toISOString()).toBe("2026-10-24T23:00:00.000Z");
  });

  it("exactly at UK midnight is the start of the new day", () => {
    expect(startOfDay(new Date("2026-07-14T23:00:00Z"), UK).toISOString()).toBe("2026-07-14T23:00:00.000Z");
    expect(startOfDay(new Date("2026-07-14T22:59:59.999Z"), UK).toISOString()).toBe("2026-07-13T23:00:00.000Z");
  });

  it("handles a leap day and the day after it", () => {
    expect(startOfNextDay(new Date("2028-02-28T12:00:00Z"), UK).toISOString()).toBe("2028-02-29T00:00:00.000Z");
    expect(startOfNextDay(new Date("2028-02-29T12:00:00Z"), UK).toISOString()).toBe("2028-03-01T00:00:00.000Z");
  });

  it("every UK day in 2026 and 2027 is 23, 24 or 25 hours long and starts at local midnight", () => {
    const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: UK, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    let day = startOfDay(new Date("2026-01-01T12:00:00Z"), UK);
    const lengths = new Map<number, number>();
    for (let i = 0; i < 730; i++) {
      expect(fmt.format(day)).toBe("00:00");
      const next = startOfNextDay(day, UK);
      const hours = (next.getTime() - day.getTime()) / 3_600_000;
      lengths.set(hours, (lengths.get(hours) ?? 0) + 1);
      day = next;
    }
    expect(lengths).toEqual(new Map([[24, 726], [23, 2], [25, 2]]));
  });
});

describe("UK month boundaries through the clock changes", () => {
  it("a month that starts in GMT and ends in BST (March)", () => {
    const now = new Date("2026-03-31T12:00:00Z");
    expect(startOfMonth(now, UK).toISOString()).toBe("2026-03-01T00:00:00.000Z");
    expect(startOfNextMonth(now, UK).toISOString()).toBe("2026-03-31T23:00:00.000Z");
  });

  it("23:30 UTC on 31 March is already April in the UK", () => {
    expect(startOfMonth(new Date("2026-03-31T23:30:00Z"), UK).toISOString()).toBe("2026-03-31T23:00:00.000Z");
  });

  it("a month that starts in BST and ends in GMT (October)", () => {
    const now = new Date("2026-10-31T23:30:00Z"); // 23:30 GMT, still October
    expect(startOfMonth(now, UK).toISOString()).toBe("2026-09-30T23:00:00.000Z");
    expect(startOfNextMonth(now, UK).toISOString()).toBe("2026-11-01T00:00:00.000Z");
  });

  it("every month start in 2026-2027 is local midnight on the 1st", () => {
    const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: UK, day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    let month = startOfMonth(new Date("2026-01-15T12:00:00Z"), UK);
    for (let i = 0; i < 24; i++) {
      expect(fmt.format(month)).toBe("01, 00:00");
      month = startOfNextMonth(month, UK);
    }
    expect(month.toISOString()).toBe("2028-01-01T00:00:00.000Z");
  });
});

describe("daily caps across the UK day rollover in the guard", () => {
  it("in BST, a cap hit at 23:59 local resets at 00:00 local (23:00 UTC)", async () => {
    const { guard, setNow } = setup("2026-07-15T22:59:00Z");
    for (let i = 0; i < DAILY_CAPS.outfit_request; i++) await guard.reserveAction(ALICE, "outfit_request");
    expect((await capOf(guard.assertCanStart(ALICE, "outfit_request")))?.resetsAt.toISOString()).toBe("2026-07-15T23:00:00.000Z");
    setNow("2026-07-15T23:00:00Z");
    expect(await capOf(guard.assertCanStart(ALICE, "outfit_request"))).toBeNull();
  });

  it("in BST, a UTC-midnight reset would be wrong: usage at 23:30 UTC counts for the new UK day", async () => {
    const { guard, setNow } = setup("2026-07-15T23:30:00Z"); // 00:30 BST on the 16th
    await guard.reserveAction(ALICE, "item_ingest");
    setNow("2026-07-16T10:00:00Z");
    expect((await guard.summary(ALICE)).itemsToday.used).toBe(1);
  });

  it("on the 25-hour day the clocks go back, the cap holds for all 25 hours", async () => {
    const { guard, setNow } = setup("2026-10-24T23:10:00Z"); // 00:10 BST on the 25th
    for (let i = 0; i < DAILY_CAPS.item_ingest; i++) await guard.reserveAction(ALICE, "item_ingest");
    setNow("2026-10-25T23:50:00Z"); // 23:50 GMT, still the 25th
    const error = await capOf(guard.assertCanStart(ALICE, "item_ingest"));
    expect(error?.resetsAt.toISOString()).toBe("2026-10-26T00:00:00.000Z");
    setNow("2026-10-26T00:00:00Z");
    expect(await capOf(guard.assertCanStart(ALICE, "item_ingest"))).toBeNull();
  });

  it("on the 23-hour day the clocks go forward, the reset is at 23:00 UTC", async () => {
    const { guard, setNow } = setup("2026-03-29T12:00:00Z");
    for (let i = 0; i < DAILY_CAPS.item_ingest; i++) await guard.reserveAction(ALICE, "item_ingest");
    expect((await guard.summary(ALICE)).dailyResetAt).toBe("2026-03-29T23:00:00.000Z");
    setNow("2026-03-29T22:59:59Z");
    expect(await capOf(guard.assertCanStart(ALICE, "item_ingest"))).not.toBeNull();
    setNow("2026-03-29T23:00:00Z");
    expect(await capOf(guard.assertCanStart(ALICE, "item_ingest"))).toBeNull();
  });
});

describe("£5/month AI spend cap", () => {
  it("is not paused one hundredth of a penny below the cap, and is paused exactly at it", async () => {
    const { guard } = setup("2026-10-21T10:00:00Z");
    await guard.recordAiCost(ALICE, "ranking_final", MONTHLY_AI_SPEND_CAP_PENCE - 0.01, "fake");
    expect(await guard.isAiPaused()).toBe(false);
    await guard.recordAiCost(ALICE, "tagging", 0.01, "fake");
    expect(await guard.isAiPaused()).toBe(true);
  });

  // Was pinned with it.fails (float drift: 2500 x 0.2p summed to
  // 499.99999999998p). Fixed by summing in ten-thousandths of a penny.
  it("reaches the cap from estimated costs alone (2500 tagging calls at 0.2p)", async () => {
    const { guard } = setup("2026-10-21T10:00:00Z");
    for (let i = 0; i < 2499; i++) await guard.recordAiCost(i % 2 ? ALICE : BOB, "tagging");
    expect(await guard.isAiPaused()).toBe(false);
    await guard.recordAiCost(null, "tagging");
    expect(await guard.isAiPaused()).toBe(true);
  });

  it("keeps a reported cost of 0 rather than replacing it with the estimate", async () => {
    const { guard, store } = setup("2026-10-21T10:00:00Z");
    await guard.recordAiCost(ALICE, "ranking_final", 0, "gemini");
    expect(store.events[0]).toMatchObject({ costPence: 0, provider: "gemini", userId: ALICE, kind: "ranking_final" });
  });

  it("stops every AI action for every user, even with daily allowance left, and says when it resumes", async () => {
    const { guard } = setup("2026-10-21T10:00:00Z");
    await guard.recordAiCost(BOB, "tagging", MONTHLY_AI_SPEND_CAP_PENCE, "fake");
    for (const user of [ALICE, BOB]) {
      for (const action of ["item_ingest", "outfit_request"] as const) {
        const error = await capOf(guard.assertCanStart(user, action));
        expect(error?.cap).toBe("monthly_ai_spend");
        expect(error?.toApiException().code).toBe("ai_paused");
        expect(error?.toApiException().extras.cap).toEqual({
          kind: "monthly_ai_spend",
          limit: 500,
          resetsAt: "2026-11-01T00:00:00.000Z",
        });
      }
    }
    expect(await capOf(guard.assertAiAvailable())).not.toBeNull();
    expect((await guard.summary(ALICE)).aiPaused).toBe(true);
  });

  it("reports ai_paused ahead of a daily cap when both apply", async () => {
    const { guard } = setup("2026-10-21T10:00:00Z");
    for (let i = 0; i < DAILY_CAPS.item_ingest; i++) await guard.reserveAction(ALICE, "item_ingest");
    await guard.recordAiCost(ALICE, "tagging", 1000);
    expect((await capOf(guard.assertCanStart(ALICE, "item_ingest")))?.cap).toBe("monthly_ai_spend");
  });

  it("still counts the spend of a deleted account (null user)", async () => {
    const { guard } = setup("2026-10-21T10:00:00Z");
    await guard.recordAiCost(null, "ranking_final", MONTHLY_AI_SPEND_CAP_PENCE);
    expect(await guard.isAiPaused()).toBe(true);
  });

  it("ignores last month's spend, using UK month boundaries in BST", async () => {
    const { guard, setNow } = setup("2026-03-31T22:30:00Z"); // 23:30 BST, 31 March
    await guard.recordAiCost(ALICE, "tagging", MONTHLY_AI_SPEND_CAP_PENCE);
    expect(await guard.isAiPaused()).toBe(true);
    expect((await capOf(guard.assertAiAvailable()))?.resetsAt.toISOString()).toBe("2026-03-31T23:00:00.000Z");
    setNow("2026-03-31T23:00:00Z"); // 00:00 BST, 1 April
    expect(await guard.isAiPaused()).toBe(false);
  });

  it("stays paused through 23:30 UTC on 31 October (GMT), resuming at 00:00 UTC", async () => {
    const { guard, setNow } = setup("2026-10-02T09:00:00Z");
    await guard.recordAiCost(ALICE, "tagging", MONTHLY_AI_SPEND_CAP_PENCE);
    setNow("2026-10-31T23:59:59Z");
    expect(await guard.isAiPaused()).toBe(true);
    setNow("2026-11-01T00:00:00Z");
    expect(await guard.isAiPaused()).toBe(false);
  });

  it("spend from 1 October 00:30 BST (30 Sept 23:30 UTC) counts towards October", async () => {
    const { guard, setNow } = setup("2026-09-30T23:30:00Z");
    await guard.recordAiCost(ALICE, "tagging", MONTHLY_AI_SPEND_CAP_PENCE);
    setNow("2026-10-15T12:00:00Z");
    expect(await guard.isAiPaused()).toBe(true);
  });
});

describe("summary", () => {
  it("only counts the asking user's actions but reports the shared AI pause", async () => {
    const { guard } = setup("2026-10-21T10:00:00Z");
    await guard.reserveAction(BOB, "item_ingest");
    await guard.reserveAction(BOB, "outfit_request");
    await guard.recordAiCost(BOB, "ranking_final", MONTHLY_AI_SPEND_CAP_PENCE);
    expect(await guard.summary(ALICE)).toEqual({
      itemsToday: { used: 0, limit: 40 },
      outfitRequestsToday: { used: 0, limit: 25 },
      dailyResetAt: "2026-10-21T23:00:00.000Z",
      aiPaused: true,
    });
  });
});
