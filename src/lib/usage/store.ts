import type { SupabaseClient } from "@supabase/supabase-js";
import type { UsageEventKind } from "@/contracts";

export interface UsageEvent {
  /** Null for system work not tied to a user. */
  userId: string | null;
  kind: UsageEventKind;
  costPence: number;
  provider: string | null;
}

/** Where usage events are kept. The real one is the usage_events table. */
export interface UsageStore {
  /** How many events of this kind the user has had since `since`. */
  countSince(userId: string, kind: UsageEventKind, since: Date): Promise<number>;
  /** Total cost of all users' events since `since`, in pence. */
  spendSince(since: Date): Promise<number>;
  record(event: UsageEvent): Promise<void>;
}

/**
 * Costs are kept to 4 decimal places of a penny, like the database column
 * (numeric(12, 4)). Summing in whole ten-thousandths avoids float drift:
 * 2,500 × 0.2p must make exactly 500p, not 499.99999999998p.
 */
const COST_SCALE = 10_000;
const toUnits = (pence: number) => Math.round(pence * COST_SCALE);

/** For tests and mock mode. */
export class InMemoryUsageStore implements UsageStore {
  readonly events: (UsageEvent & { at: Date })[] = [];

  constructor(private readonly now: () => Date = () => new Date()) {}

  async countSince(userId: string, kind: UsageEventKind, since: Date): Promise<number> {
    return this.events.filter((e) => e.userId === userId && e.kind === kind && e.at >= since).length;
  }

  async spendSince(since: Date): Promise<number> {
    const units = this.events.filter((e) => e.at >= since).reduce((sum, e) => sum + toUnits(e.costPence), 0);
    return units / COST_SCALE;
  }

  async record(event: UsageEvent): Promise<void> {
    this.events.push({ ...event, at: this.now() });
  }
}

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
