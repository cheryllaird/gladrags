import type { AiCostKind, CappedAction, SpendShare, UsageSummary } from "@/contracts";
import {
  DAILY_CAPS,
  ESTIMATED_COST_PENCE,
  MAX_SETTLED_COST_PENCE,
  MONTHLY_AI_SPEND_CAP_PENCE,
  MONTHLY_SPEND_SHARES,
  SHARE_FOR_ACTION,
  SHARE_FOR_COST_KIND,
  USAGE_TIME_ZONE,
} from "./config";
import { CapReachedError, type CapKind } from "./errors";
import type { UsageStore } from "./store";
import { startOfDay, startOfMonth, startOfNextDay, startOfNextMonth } from "./time";

export interface UsageLimits {
  dailyCaps: Readonly<Record<CappedAction, number>>;
  monthlySpendCapPence: number;
  timeZone: string;
  /** Per-feature monthly shares (round 2). Missing: MONTHLY_SPEND_SHARES. */
  spendShares?: Readonly<Record<SpendShare, { kinds: readonly AiCostKind[]; capPence: number }>>;
}

export const DEFAULT_USAGE_LIMITS: UsageLimits = {
  dailyCaps: DAILY_CAPS,
  monthlySpendCapPence: MONTHLY_AI_SPEND_CAP_PENCE,
  timeZone: USAGE_TIME_ZONE,
  spendShares: MONTHLY_SPEND_SHARES,
};

/** Which cap kind an error reports when a share is reached. */
const SHARE_CAP_KIND: Record<SpendShare, CapKind> = {
  images: "monthly_image_spend",
  shop_search: "monthly_shop_search_spend",
};

const CAP_KIND: Record<CappedAction, CapKind> = {
  item_ingest: "items_per_day",
  outfit_request: "outfit_requests_per_day",
  link_fetch: "link_fetches_per_day",
  email_import: "emails_per_day",
  shop_search: "shop_searches_per_day",
  outfit_preview: "outfit_previews_per_day",
};

/** Daily actions that lead to AI calls, so they're refused while AI is paused. */
const USES_AI: Record<CappedAction, boolean> = {
  item_ingest: true,
  outfit_request: true,
  link_fetch: false,
  email_import: true,
  shop_search: true,
  outfit_preview: true,
};

/**
 * A settled AI cost is recorded at most this many times its estimate, which
 * bounds how far calls already in flight can take the month past £5.
 */
export const MAX_SETTLED_COST_MULTIPLE = 3;

/** The most a settled cost of this kind is recorded at (MAX_SETTLED_COST_PENCE, else 3 × the estimate). */
export function maxSettledCost(kind: AiCostKind): number {
  return MAX_SETTLED_COST_PENCE[kind] ?? ESTIMATED_COST_PENCE[kind] * MAX_SETTLED_COST_MULTIPLE;
}

/** A provider-reported cost if it's a real, non-negative number; otherwise the estimate. */
function usableCost(reported: number | undefined, estimate: number): number {
  return reported !== undefined && Number.isFinite(reported) && reported >= 0 ? reported : estimate;
}

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
    const share = SHARE_FOR_ACTION[action];
    if (share) await this.assertShareAvailable(share);
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

  /** Throws CapReachedError (ai_paused, the share's cap kind) if this share of the month is spent. */
  async assertShareAvailable(share: SpendShare): Promise<void> {
    if (await this.isSharePaused(share)) throw this.shareCapError(share);
  }

  /** True when this feature's share of the month is spent. Doesn't look at the overall cap. */
  async isSharePaused(share: SpendShare): Promise<boolean> {
    const { kinds, capPence } = this.share(share);
    const spent = await this.store.spendSince(this.monthStart(), kinds);
    return spent >= capPence;
  }

  /**
   * Count one capped action (an item upload or link import that gets
   * tagged, an outfit request or refinement, a link page fetch), checking
   * the caps in the same atomic step. Throws CapReachedError instead of
   * counting if the cap (or, for AI actions, the monthly pause) is reached.
   */
  async reserveAction(userId: string, action: CappedAction): Promise<UsageReservation> {
    const usesAi = USES_AI[action];
    const share = SHARE_FOR_ACTION[action];
    const result = await this.store.reserve({
      userId,
      kind: action,
      costPence: 0,
      provider: null,
      dailyLimit: this.limits.dailyCaps[action],
      dayStart: this.dayStart(),
      monthlyCapPence: usesAi ? this.limits.monthlySpendCapPence : null,
      monthStart: usesAi || share ? this.monthStart() : null,
      ...this.shareRequest(share),
    });
    if (!result.ok) throw this.deniedError(result.denied, action, share);
    const { eventId } = result;
    return { cancel: () => this.store.cancel(eventId) };
  }

  /**
   * Reserve one AI call's estimated cost before making it. Throws
   * CapReachedError (ai_paused) if the month's spend has reached the cap.
   * Returns the reservation's ID for `settleAiCost`.
   */
  async reserveAiCost(userId: string | null, kind: AiCostKind, provider?: string): Promise<string> {
    const share = SHARE_FOR_COST_KIND[kind];
    const result = await this.store.reserve({
      userId,
      kind,
      costPence: ESTIMATED_COST_PENCE[kind],
      provider: provider ?? null,
      dailyLimit: null,
      dayStart: null,
      monthlyCapPence: this.limits.monthlySpendCapPence,
      monthStart: this.monthStart(),
      ...this.shareRequest(share),
    });
    if (!result.ok) throw result.denied === "share_spend" && share ? this.shareCapError(share) : this.monthlyCapError();
    return result.eventId;
  }

  /**
   * After the call: record which provider answered and the real cost, if
   * it reported a usable one (otherwise the estimate stands). The settled
   * cost is clamped to MAX_SETTLED_COST_MULTIPLE times the estimate, so
   * calls in flight when the month reaches £5 can take it past the cap by
   * at most (multiple - 1) × estimate each (CONTRACTS.md section 7). A
   * clamp is logged, as it means the estimates need raising.
   */
  async settleAiCost(reservationId: string, kind: AiCostKind, call: MeteredCall): Promise<void> {
    const estimate = ESTIMATED_COST_PENCE[kind];
    let cost = usableCost(call.costPence, estimate);
    const max = maxSettledCost(kind);
    if (cost > max) {
      console.warn("AI call cost above the cap's bound; recorded at the bound. Raise ESTIMATED_COST_PENCE.", { kind, reported: cost, recorded: max });
      cost = max;
    }
    await this.store.settle(reservationId, cost, call.provider);
  }

  /**
   * Record a cost that's already been incurred, without checking the cap.
   * Prefer `meterAiCalls`, which reserves before each call. A missing,
   * non-finite or negative cost records the estimate instead.
   */
  async recordAiCost(userId: string | null, kind: AiCostKind, costPence?: number, provider?: string): Promise<void> {
    await this.store.record({
      userId,
      kind,
      costPence: usableCost(costPence, ESTIMATED_COST_PENCE[kind]),
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
    const [items, outfits, emails, shopSearches, previews, aiPaused, imagesPaused, shopSharePaused] = await Promise.all([
      this.store.countSince(userId, "item_ingest", since),
      this.store.countSince(userId, "outfit_request", since),
      this.store.countSince(userId, "email_import", since),
      this.store.countSince(userId, "shop_search", since),
      this.store.countSince(userId, "outfit_preview", since),
      this.isAiPaused(),
      this.isSharePaused("images"),
      this.isSharePaused("shop_search"),
    ]);
    return {
      itemsToday: { used: items, limit: this.limits.dailyCaps.item_ingest },
      outfitRequestsToday: { used: outfits, limit: this.limits.dailyCaps.outfit_request },
      emailsToday: { used: emails, limit: this.limits.dailyCaps.email_import },
      shopSearchesToday: { used: shopSearches, limit: this.limits.dailyCaps.shop_search },
      outfitPreviewsToday: { used: previews, limit: this.limits.dailyCaps.outfit_preview },
      dailyResetAt: startOfNextDay(this.now(), this.limits.timeZone).toISOString(),
      aiPaused,
      previewsPaused: aiPaused || imagesPaused,
      shopSearchPaused: aiPaused || shopSharePaused,
    };
  }

  private share(share: SpendShare): { kinds: readonly AiCostKind[]; capPence: number } {
    return (this.limits.spendShares ?? MONTHLY_SPEND_SHARES)[share];
  }

  private shareRequest(share: SpendShare | undefined) {
    if (!share) return { shareKinds: null, shareCapPence: null };
    const { kinds, capPence } = this.share(share);
    return { shareKinds: kinds, shareCapPence: capPence };
  }

  private deniedError(denied: "daily_cap" | "monthly_spend" | "share_spend", action: CappedAction, share: SpendShare | undefined): CapReachedError {
    if (denied === "monthly_spend") return this.monthlyCapError();
    if (denied === "share_spend" && share) return this.shareCapError(share);
    return this.dailyCapError(action);
  }

  private shareCapError(share: SpendShare): CapReachedError {
    return new CapReachedError(SHARE_CAP_KIND[share], this.share(share).capPence, startOfNextMonth(this.now(), this.limits.timeZone));
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
