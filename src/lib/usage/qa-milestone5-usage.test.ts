/**
 * QA: the milestone 5 caps (forwarded emails and shop searches, 10 a day
 * each) and the new costed kinds, against the real config values.
 */
import { describe, expect, it } from "vitest";
import { CAP_KINDS, CAPPED_ACTIONS, USAGE_EVENT_KINDS, UsageSummarySchema, type CappedAction } from "@/contracts";
import { throwIfCapMarker } from "@/lib/mocks/markers";
import { DAILY_CAPS, ESTIMATED_COST_PENCE, MONTHLY_AI_SPEND_CAP_PENCE } from "./config";
import { CapReachedError } from "./errors";
import { DEFAULT_USAGE_LIMITS, UsageGuard } from "./guard";
import { InMemoryUsageStore } from "./store";

const ALICE = "0a000000-0000-4000-8000-000000000001";
const BOB = "0b000000-0000-4000-8000-000000000002";

function setup(start = "2026-10-30T10:00:00Z") {
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

async function useUp(guard: UsageGuard, user: string, action: CappedAction, n: number) {
  for (let i = 0; i < n; i++) await guard.reserveAction(user, action);
}

describe("config covers every kind", () => {
  it("has a daily cap for every capped action and an estimate for every costed kind, and nothing else", () => {
    expect(Object.keys(DAILY_CAPS).sort()).toEqual([...CAPPED_ACTIONS].sort());
    const costed = USAGE_EVENT_KINDS.filter((k) => !(CAPPED_ACTIONS as readonly string[]).includes(k));
    expect(Object.keys(ESTIMATED_COST_PENCE).sort()).toEqual([...costed].sort());
    for (const value of [...Object.values(DAILY_CAPS), ...Object.values(ESTIMATED_COST_PENCE)]) {
      expect(value).toBeGreaterThan(0);
    }
  });

  it("emails and shop searches are 10 a day; a shop search is the dearest call", () => {
    expect(DAILY_CAPS.email_import).toBe(10);
    expect(DAILY_CAPS.shop_search).toBe(10);
    expect(Math.max(...Object.values(ESTIMATED_COST_PENCE))).toBe(ESTIMATED_COST_PENCE.shop_grounding);
  });

  it("a whole day of shop searches by one user can't spend more than the month's cap on its own", () => {
    expect(DAILY_CAPS.shop_search * ESTIMATED_COST_PENCE.shop_grounding).toBeLessThan(MONTHLY_AI_SPEND_CAP_PENCE);
  });

  it("every cap kind except the monthly one belongs to a capped action", () => {
    expect(CAP_KINDS).toHaveLength(CAPPED_ACTIONS.length + 1);
  });
});

describe.each<[CappedAction, string]>([
  ["email_import", "emails_per_day"],
  ["shop_search", "shop_searches_per_day"],
])("%s", (action, capKind) => {
  it(`allows ${DAILY_CAPS[action]} a day, then refuses with ${capKind}`, async () => {
    const { guard } = setup();
    await useUp(guard, ALICE, action, DAILY_CAPS[action]);
    const error = await capOf(guard.reserveAction(ALICE, action));
    expect(error?.cap).toBe(capKind);
    expect(error?.limit).toBe(DAILY_CAPS[action]);
    expect(await capOf(guard.assertCanStart(ALICE, action))).not.toBeNull();
  });

  it("counts per user, separately from the other caps", async () => {
    const { guard } = setup();
    await useUp(guard, ALICE, action, DAILY_CAPS[action]);
    expect(await capOf(guard.reserveAction(BOB, action))).toBeNull();
    expect(await capOf(guard.reserveAction(ALICE, "item_ingest"))).toBeNull();
    expect(await capOf(guard.reserveAction(ALICE, "outfit_request"))).toBeNull();
  });

  it("resets at midnight UK time", async () => {
    const { guard, setNow } = setup("2026-10-30T22:30:00Z"); // 22:30 GMT
    await useUp(guard, ALICE, action, DAILY_CAPS[action]);
    expect(await capOf(guard.reserveAction(ALICE, action))).not.toBeNull();
    setNow("2026-10-31T00:00:01Z");
    expect(await capOf(guard.reserveAction(ALICE, action))).toBeNull();
  });

  it("is refused while AI is paused, before anything is counted", async () => {
    const { guard, store } = setup();
    await guard.recordAiCost(null, "ranking_final", MONTHLY_AI_SPEND_CAP_PENCE);
    expect((await capOf(guard.reserveAction(ALICE, action)))?.cap).toBe("monthly_ai_spend");
    expect((await capOf(guard.assertCanStart(ALICE, action)))?.cap).toBe("monthly_ai_spend");
    expect(await store.countSince(ALICE, action, new Date(0))).toBe(0);
  });

  it("a cancelled reservation gives the count back", async () => {
    const { guard } = setup();
    await useUp(guard, ALICE, action, DAILY_CAPS[action] - 1);
    const last = await guard.reserveAction(ALICE, action);
    await last.cancel();
    expect(await capOf(guard.reserveAction(ALICE, action))).toBeNull();
  });

  it("turns into a 429 with the cap kind and a plain message", () => {
    const api = new CapReachedError(capKind as never, DAILY_CAPS[action], new Date("2026-10-31T00:00:00Z")).toApiException();
    expect(api.code).toBe("daily_cap_reached");
    expect(api.message).toMatch(/10/);
    expect(api.message).not.toMatch(/undefined|items today|outfits/);
  });

  it("the mock-daily-cap marker names the right cap", () => {
    let thrown: unknown;
    try {
      throwIfCapMarker(["please mock-daily-cap"], action);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CapReachedError);
    expect((thrown as CapReachedError).cap).toBe(capKind);
  });
});

describe("summary", () => {
  it("reports today's emails and shop searches, per user", async () => {
    const { guard } = setup();
    await useUp(guard, ALICE, "email_import", 3);
    await useUp(guard, ALICE, "shop_search", 2);
    await useUp(guard, BOB, "shop_search", 5);
    const summary = UsageSummarySchema.parse(await guard.summary(ALICE));
    expect(summary.emailsToday).toEqual({ used: 3, limit: 10 });
    expect(summary.shopSearchesToday).toEqual({ used: 2, limit: 10 });
    expect(summary.itemsToday.used).toBe(0);
  });

  it("the new costed kinds count towards the monthly pause", async () => {
    const { guard } = setup();
    for (let i = 0; i < Math.ceil(MONTHLY_AI_SPEND_CAP_PENCE / ESTIMATED_COST_PENCE.shop_grounding); i++) {
      await guard.recordAiCost(ALICE, "shop_grounding");
    }
    expect(await guard.isAiPaused()).toBe(true);
  });

  it("email extraction is costed at its estimate", async () => {
    const { guard, store } = setup();
    await guard.recordAiCost(ALICE, "email_extraction");
    expect(await store.spendSince(new Date(0))).toBeCloseTo(ESTIMATED_COST_PENCE.email_extraction);
  });
});
