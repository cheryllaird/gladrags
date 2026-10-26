import type { AiCostKind, CappedAction, UsageSummary } from "@/contracts";
import { DAILY_CAPS, ESTIMATED_COST_PENCE, MONTHLY_AI_SPEND_CAP_PENCE, USAGE_TIME_ZONE } from "./config";
import { CapReachedError, type CapKind } from "./errors";
import type { UsageStore } from "./store";
import { startOfDay, startOfMonth, startOfNextDay, startOfNextMonth } from "./time";

export interface UsageLimits {
  dailyCaps: Readonly<Record<CappedAction, number>>;
  monthlySpendCapPence: number;
  timeZone: string;
}

export const DEFAULT_USAGE_LIMITS: UsageLimits = {
  dailyCaps: DAILY_CAPS,
  monthlySpendCapPence: MONTHLY_AI_SPEND_CAP_PENCE,
  timeZone: USAGE_TIME_ZONE,
};

const CAP_KIND: Record<CappedAction, CapKind> = {
  item_ingest: "items_per_day",
  outfit_request: "outfit_requests_per_day",
  link_fetch: "link_fetches_per_day",
};

/** Daily actions that lead to AI calls, so they're refused while AI is paused. */
const USES_AI: Record<CappedAction, boolean> = {
  item_ingest: true,
  outfit_request: true,
  link_fetch: false,
};

/** A counted action, which can be taken back if it didn't happen after all. */
export interface UsageReservation {
  /** Delete the reservation, e.g. when the link import it was for turned out to be used already. */
  cancel(): Promise<void>;
}

/** The real cost of a model call, as far as it's known. */
export interface MeteredCall {
  /** Undefined when the provider couldn't say (or threw): the estimate stands. */
  costPence?: number;
  provider: string;
}

/**
 * Hooks for callWithValidation: reserve each Gemini call's estimated cost
 * before it's made, then settle it with the real cost.
 */
export interface AiCallMeter {
  beforeCall: () => Promise<void>;
  onCall: (call: MeteredCall) => Promise<void>;
}

/**
 * Enforces the per-user daily caps and the £5/month AI spend cap.
 *
 * Checking and counting are one atomic step (`reserveAction`,
 * `reserveAiCost`): the database version locks and counts in one SQL
 * function, so requests sent at the same moment can't overshoot a cap.
 *
 * How the owning agents use it (ingestion, link-import, outfit-engine):
 *
 *   const usage = getUsageGuard();
 *   await usage.assertCanStart(user.id, "item_ingest");  // early, cheap check before any work
 *   ... validate input ...
 *   await usage.reserveAction(user.id, "item_ingest");   // counts it, or throws CapReachedError
 *   ... call the model through callWithValidation with ...usage.meterAiCalls(user.id, "tagging")
 *
 * withApiHandler turns CapReachedError into a 429 (daily_cap_reached) or
 * 503 (ai_paused) response.
 */
export class UsageGuard {
  constructor(
    private readonly store: UsageStore,
    private readonly limits: UsageLimits = DEFAULT_USAGE_LIMITS,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Throws CapReachedError if AI is paused (for actions that use AI) or the
   * user hit today's cap for this action. A check only: it counts nothing,
   * and a request that passes can still be refused by `reserveAction`.
   */
  async assertCanStart(userId: string, action: CappedAction): Promise<void> {
    if (USES_AI[action]) await this.assertAiAvailable();
    const used = await this.store.countSince(userId, action, this.dayStart());
    const limit = this.limits.dailyCaps[action];
    if (used >= limit) throw this.dailyCapError(action);
  }

  /** Throws CapReachedError if this month's AI spend has reached the cap. */
  async assertAiAvailable(): Promise<void> {
    if (await this.isAiPaused()) throw this.monthlyCapError();
  }

  async isAiPaused(): Promise<boolean> {
    const spent = await this.store.spendSince(this.monthStart());
    return spent >= this.limits.monthlySpendCapPence;
  }

  /**
   * Count one capped action (an item upload or link import that gets
   * tagged, an outfit request or refinement, a link page fetch), checking
   * the caps in the same atomic step. Throws CapReachedError instead of
   * counting if the cap (or, for AI actions, the monthly pause) is reached.
   */
  async reserveAction(userId: string, action: CappedAction): Promise<UsageReservation> {
    const usesAi = USES_AI[action];
    const result = await this.store.reserve({
      userId,
      kind: action,
      costPence: 0,
      provider: null,
      dailyLimit: this.limits.dailyCaps[action],
      dayStart: this.dayStart(),
      monthlyCapPence: usesAi ? this.limits.monthlySpendCapPence : null,
      monthStart: usesAi ? this.monthStart() : null,
    });
    if (!result.ok) throw result.denied === "monthly_spend" ? this.monthlyCapError() : this.dailyCapError(action);
    const { eventId } = result;
    return { cancel: () => this.store.cancel(eventId) };
  }

  /**
   * Reserve one AI call's estimated cost before making it. Throws
   * CapReachedError (ai_paused) if the month's spend has reached the cap.
   * Returns the reservation's ID for `settleAiCost`.
   */
  async reserveAiCost(userId: string | null, kind: AiCostKind, provider?: string): Promise<string> {
    const result = await this.store.reserve({
      userId,
      kind,
      costPence: ESTIMATED_COST_PENCE[kind],
      provider: provider ?? null,
      dailyLimit: null,
      dayStart: null,
      monthlyCapPence: this.limits.monthlySpendCapPence,
      monthStart: this.monthStart(),
    });
    if (!result.ok) throw this.monthlyCapError();
    return result.eventId;
  }

  /**
   * After the call: record which provider answered and the real cost, if
   * it reported one (otherwise the estimate stands). A real cost above the
   * estimate can take the month slightly past the cap; the next
   * reservation is then refused.
   */
  async settleAiCost(reservationId: string, kind: AiCostKind, call: MeteredCall): Promise<void> {
    await this.store.settle(reservationId, call.costPence ?? ESTIMATED_COST_PENCE[kind], call.provider);
  }

  /**
   * Record a cost that's already been incurred, without checking the cap.
   * Prefer `meterAiCalls`, which reserves before each call.
   */
  async recordAiCost(userId: string | null, kind: AiCostKind, costPence?: number, provider?: string): Promise<void> {
    await this.store.record({
      userId,
      kind,
      costPence: costPence ?? ESTIMATED_COST_PENCE[kind],
      provider: provider ?? null,
    });
  }

  /**
   * beforeCall/onCall hooks for callWithValidation: every attempt reserves
   * its estimated cost first (or is refused with ai_paused), then settles
   * it with the real cost once known.
   *
   *   callWithValidation(Schema, call, { ...usage.meterAiCalls(user.id, "tagging", "gemini"), provider: "gemini" })
   */
  meterAiCalls(userId: string | null, kind: AiCostKind, provider?: string): AiCallMeter {
    let pending: string | null = null;
    return {
      beforeCall: async () => {
        pending = await this.reserveAiCost(userId, kind, provider);
      },
      onCall: async (call) => {
        const reservation = pending;
        pending = null;
        if (reservation) await this.settleAiCost(reservation, kind, call);
        else await this.recordAiCost(userId, kind, call.costPence, call.provider);
      },
    };
  }

  async summary(userId: string): Promise<UsageSummary> {
    const since = this.dayStart();
    const [items, outfits, aiPaused] = await Promise.all([
      this.store.countSince(userId, "item_ingest", since),
      this.store.countSince(userId, "outfit_request", since),
      this.isAiPaused(),
    ]);
    return {
      itemsToday: { used: items, limit: this.limits.dailyCaps.item_ingest },
      outfitRequestsToday: { used: outfits, limit: this.limits.dailyCaps.outfit_request },
      dailyResetAt: startOfNextDay(this.now(), this.limits.timeZone).toISOString(),
      aiPaused,
    };
  }

  private dailyCapError(action: CappedAction): CapReachedError {
    return new CapReachedError(CAP_KIND[action], this.limits.dailyCaps[action], startOfNextDay(this.now(), this.limits.timeZone));
  }

  private monthlyCapError(): CapReachedError {
    return new CapReachedError("monthly_ai_spend", this.limits.monthlySpendCapPence, startOfNextMonth(this.now(), this.limits.timeZone));
  }

  private dayStart(): Date {
    return startOfDay(this.now(), this.limits.timeZone);
  }

  private monthStart(): Date {
    return startOfMonth(this.now(), this.limits.timeZone);
  }
}
