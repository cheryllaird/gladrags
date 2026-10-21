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
};

/**
 * Enforces the per-user daily caps and the £5/month AI spend cap.
 *
 * How the owning agents use it (ingestion, link-import, outfit-engine):
 *
 *   const usage = getUsageGuard();
 *   await usage.assertCanStart(user.id, "item_ingest"); // throws CapReachedError
 *   await usage.recordAction(user.id, "item_ingest");
 *   ... call providers; after each AI call:
 *   await usage.recordAiCost(user.id, "tagging", call.costPence, call.provider);
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

  /** Throws CapReachedError if AI is paused or the user hit today's cap for this action. */
  async assertCanStart(userId: string, action: CappedAction): Promise<void> {
    await this.assertAiAvailable();
    const used = await this.store.countSince(userId, action, this.dayStart());
    const limit = this.limits.dailyCaps[action];
    if (used >= limit) {
      throw new CapReachedError(CAP_KIND[action], limit, startOfNextDay(this.now(), this.limits.timeZone));
    }
  }

  /** Throws CapReachedError if this month's AI spend has reached the cap. */
  async assertAiAvailable(): Promise<void> {
    if (await this.isAiPaused()) {
      throw new CapReachedError(
        "monthly_ai_spend",
        this.limits.monthlySpendCapPence,
        startOfNextMonth(this.now(), this.limits.timeZone),
      );
    }
  }

  async isAiPaused(): Promise<boolean> {
    const spent = await this.store.spendSince(startOfMonth(this.now(), this.limits.timeZone));
    return spent >= this.limits.monthlySpendCapPence;
  }

  /** Count one capped action (an item upload/import, or an outfit request/refinement). */
  async recordAction(userId: string, action: CappedAction): Promise<void> {
    await this.store.record({ userId, kind: action, costPence: 0, provider: null });
  }

  /** Record one AI call's cost. Leave costPence out to use the estimate for that kind. */
  async recordAiCost(userId: string | null, kind: AiCostKind, costPence?: number, provider?: string): Promise<void> {
    await this.store.record({
      userId,
      kind,
      costPence: costPence ?? ESTIMATED_COST_PENCE[kind],
      provider: provider ?? null,
    });
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

  private dayStart(): Date {
    return startOfDay(this.now(), this.limits.timeZone);
  }
}
