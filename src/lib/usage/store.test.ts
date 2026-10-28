/**
 * SupabaseUsageStore against a hand-made client: what it sends to
 * reserve_usage, and that it validates the reply instead of trusting it.
 * The SQL itself is checked by db:verify (supabase/tests).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { SupabaseUsageStore, type UsageReservationRequest } from "./store";

const USER = "0a000000-0000-4000-8000-000000000001";
const EVENT = "0e000000-0000-4000-8000-000000000001";

function fakeAdmin(reply: { data: unknown; error: { message: string } | null }) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const updates: { table: string; values: unknown; eq: [string, unknown] }[] = [];
  const client = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      return reply;
    },
    from: (table: string) => ({
      update: (values: unknown) => ({
        eq: async (column: string, value: unknown) => {
          updates.push({ table, values, eq: [column, value] });
          return { error: null };
        },
      }),
    }),
  } as unknown as SupabaseClient;
  return { client, calls, updates };
}

const request: UsageReservationRequest = {
  userId: USER,
  kind: "item_ingest",
  costPence: 0,
  provider: null,
  dailyLimit: 40,
  dayStart: new Date("2026-10-26T00:00:00Z"),
  monthlyCapPence: 500,
  monthStart: new Date("2026-10-01T00:00:00Z"),
};

describe("SupabaseUsageStore.reserve", () => {
  it("calls reserve_usage with the limits and UK boundaries, and returns the event ID", async () => {
    const { client, calls } = fakeAdmin({ data: { ok: true, denied: null, event_id: EVENT, used: 3, spent_pence: 12.5 }, error: null });
    expect(await new SupabaseUsageStore(client).reserve(request)).toEqual({ ok: true, eventId: EVENT });
    expect(calls).toEqual([
      {
        fn: "reserve_usage",
        args: {
          p_user: USER,
          p_kind: "item_ingest",
          p_daily_limit: 40,
          p_day_start: "2026-10-26T00:00:00.000Z",
          p_cost_pence: 0,
          p_monthly_cap_pence: 500,
          p_month_start: "2026-10-01T00:00:00.000Z",
          p_provider: null,
        },
      },
    ]);
  });

  it("passes nulls for limits that don't apply (an AI call)", async () => {
    const { client, calls } = fakeAdmin({ data: { ok: true, event_id: EVENT }, error: null });
    await new SupabaseUsageStore(client).reserve({ ...request, kind: "tagging", costPence: 0.2, provider: "gemini", dailyLimit: null, dayStart: null });
    expect(calls[0]?.args).toMatchObject({ p_daily_limit: null, p_day_start: null, p_cost_pence: 0.2, p_provider: "gemini" });
  });

  it.each([["daily_cap"], ["monthly_spend"]] as const)("reports a refusal (%s)", async (denied) => {
    const { client } = fakeAdmin({ data: { ok: false, denied, event_id: null }, error: null });
    expect(await new SupabaseUsageStore(client).reserve(request)).toEqual({ ok: false, denied });
  });

  it.each([
    ["null", null],
    ["ok without an event ID", { ok: true }],
    ["an unknown refusal", { ok: false, denied: "because" }],
    ["a string", "ok"],
  ])("throws on a malformed reply (%s) rather than allowing the action", async (_label, data) => {
    const { client } = fakeAdmin({ data, error: null });
    await expect(new SupabaseUsageStore(client).reserve(request)).rejects.toThrow();
  });

  it("throws on a database error", async () => {
    const { client } = fakeAdmin({ data: null, error: { message: "down" } });
    await expect(new SupabaseUsageStore(client).reserve(request)).rejects.toThrow("down");
  });
});

describe("SupabaseUsageStore.settle", () => {
  it("updates the reserved row's cost and provider by ID", async () => {
    const { client, updates } = fakeAdmin({ data: null, error: null });
    await new SupabaseUsageStore(client).settle(EVENT, 0.137, "gemini");
    expect(updates).toEqual([{ table: "usage_events", values: { cost_pence: 0.137, provider: "gemini" }, eq: ["id", EVENT] }]);
  });
});
