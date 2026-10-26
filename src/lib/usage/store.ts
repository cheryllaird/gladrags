import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { UsageEventKind } from "@/contracts";

export interface UsageEvent {
  /** Null for system work not tied to a user. */
  userId: string | null;
  kind: UsageEventKind;
  costPence: number;
  provider: string | null;
}

/** One reservation: check the limits and, if they allow it, record the event. */
export interface UsageReservationRequest extends UsageEvent {
  /** Refuse if the user already has this many events of `kind` since `dayStart`. Null: no daily limit. */
  dailyLimit: number | null;
  /** Start of today (UK time). Required with a daily limit. */
  dayStart: Date | null;
  /** Refuse if everyone's spend since `monthStart` has reached this. Null: not checked. */
  monthlyCapPence: number | null;
  /** Start of this month (UK time). Required with a monthly cap. */
  monthStart: Date | null;
}

export type UsageReservationResult =
  | { ok: true; eventId: string }
  | { ok: false; denied: "daily_cap" | "monthly_spend" };

/** Where usage events are kept. The real one is the usage_events table. */
export interface UsageStore {
  /** How many events of this kind the user has had since `since`. */
  countSince(userId: string, kind: UsageEventKind, since: Date): Promise<number>;
  /** Total cost of all users' events since `since`, in pence. */
  spendSince(since: Date): Promise<number>;
  /**
   * Check the limits and record the event in one atomic step, so calls made
   * at the same moment can't all pass the check before any is recorded.
   */
  reserve(request: UsageReservationRequest): Promise<UsageReservationResult>;
  /** Replace a reserved AI call's estimated cost with the real one. */
  settle(eventId: string, costPence: number, provider: string | null): Promise<void>;
  /** Take back a reservation whose action didn't happen after all. */
  cancel(eventId: string): Promise<void>;
  /** Record an event without checking any limit (a cost already incurred). */
  record(event: UsageEvent): Promise<void>;
}

/**
 * Costs are kept to 4 decimal places of a penny, like the database column
 * (numeric(12, 4)). Summing in whole ten-thousandths avoids float drift:
 * 2,500 × 0.2p must make exactly 500p, not 499.99999999998p.
 */
const COST_SCALE = 10_000;
const toUnits = (pence: number) => Math.round(pence * COST_SCALE);

/**
 * For tests and mock mode. JavaScript runs one piece of code at a time,
 * and `reserve` checks and records without awaiting in between, so it's
 * atomic like the SQL version.
 */
export class InMemoryUsageStore implements UsageStore {
  readonly events: (UsageEvent & { id: string; at: Date })[] = [];

  constructor(private readonly now: () => Date = () => new Date()) {}

  async countSince(userId: string, kind: UsageEventKind, since: Date): Promise<number> {
    return this.countNow(userId, kind, since);
  }

  async spendSince(since: Date): Promise<number> {
    return this.spendNow(since);
  }

  async reserve(request: UsageReservationRequest): Promise<UsageReservationResult> {
    // No await from here to the push: nothing else can run in between.
    if (request.monthlyCapPence !== null) {
      if (!request.monthStart) throw new Error("A monthly cap needs a month start");
      if (toUnits(this.spendNow(request.monthStart)) >= toUnits(request.monthlyCapPence)) return { ok: false, denied: "monthly_spend" };
    }
    if (request.dailyLimit !== null) {
      if (!request.userId || !request.dayStart) throw new Error("A daily limit needs a user and a day start");
      if (this.countNow(request.userId, request.kind, request.dayStart) >= request.dailyLimit) return { ok: false, denied: "daily_cap" };
    }
    const id = crypto.randomUUID();
    this.events.push({ id, userId: request.userId, kind: request.kind, costPence: request.costPence, provider: request.provider, at: this.now() });
    return { ok: true, eventId: id };
  }

  async settle(eventId: string, costPence: number, provider: string | null): Promise<void> {
    const event = this.events.find((e) => e.id === eventId);
    if (!event) throw new Error("Couldn't settle usage: no such reservation");
    event.costPence = costPence;
    event.provider = provider;
  }

  async cancel(eventId: string): Promise<void> {
    const index = this.events.findIndex((e) => e.id === eventId);
    if (index >= 0) this.events.splice(index, 1);
  }

  async record(event: UsageEvent): Promise<void> {
    this.events.push({ ...event, id: crypto.randomUUID(), at: this.now() });
  }

  private countNow(userId: string, kind: UsageEventKind, since: Date): number {
    return this.events.filter((e) => e.userId === userId && e.kind === kind && e.at >= since).length;
  }

  private spendNow(since: Date): number {
    const units = this.events.filter((e) => e.at >= since).reduce((sum, e) => sum + toUnits(e.costPence), 0);
    return units / COST_SCALE;
  }
}

/** What public.reserve_usage returns (see the hardening migration). */
const ReserveUsageResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), event_id: z.uuid() }),
  z.object({ ok: z.literal(false), denied: z.enum(["daily_cap", "monthly_spend"]) }),
]);

/**
 * Backed by the usage_events table. Needs a service-role client: users
 * can't write their own usage rows (see the usage_events migration).
 */
export class SupabaseUsageStore implements UsageStore {
  constructor(private readonly admin: SupabaseClient) {}

  async countSince(userId: string, kind: UsageEventKind, since: Date): Promise<number> {
    const { count, error } = await this.admin
      .from("usage_events")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("kind", kind)
      .gte("created_at", since.toISOString());
    if (error) throw new Error(`Couldn't count usage: ${error.message}`);
    return count ?? 0;
  }

  async spendSince(since: Date): Promise<number> {
    const { data, error } = await this.admin.rpc("ai_spend_pence_since", { p_since: since.toISOString() });
    if (error) throw new Error(`Couldn't read AI spend: ${error.message}`);
    return Number(data ?? 0);
  }

  async reserve(request: UsageReservationRequest): Promise<UsageReservationResult> {
    const { data, error } = await this.admin.rpc("reserve_usage", {
      p_user: request.userId,
      p_kind: request.kind,
      p_daily_limit: request.dailyLimit,
      p_day_start: request.dayStart?.toISOString() ?? null,
      p_cost_pence: request.costPence,
      p_monthly_cap_pence: request.monthlyCapPence,
      p_month_start: request.monthStart?.toISOString() ?? null,
      p_provider: request.provider,
    });
    if (error) throw new Error(`Couldn't reserve usage: ${error.message}`);
    const result = ReserveUsageResultSchema.parse(data);
    return result.ok ? { ok: true, eventId: result.event_id } : { ok: false, denied: result.denied };
  }

  async settle(eventId: string, costPence: number, provider: string | null): Promise<void> {
    const { error } = await this.admin.from("usage_events").update({ cost_pence: costPence, provider }).eq("id", eventId);
    if (error) throw new Error(`Couldn't settle usage: ${error.message}`);
  }

  async cancel(eventId: string): Promise<void> {
    const { error } = await this.admin.from("usage_events").delete().eq("id", eventId);
    if (error) throw new Error(`Couldn't cancel usage: ${error.message}`);
  }

  async record(event: UsageEvent): Promise<void> {
    const { error } = await this.admin.from("usage_events").insert({
      user_id: event.userId,
      kind: event.kind,
      cost_pence: event.costPence,
      provider: event.provider,
    });
    if (error) throw new Error(`Couldn't record usage: ${error.message}`);
  }
}
