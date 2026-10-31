import type { CapKind } from "@/contracts";
import { ApiException } from "@/lib/api/errors";

export type { CapKind };

/**
 * True for the monthly AI pause. Routes that counted a daily action and
 * then hit the pause before their model call give the count back (the
 * user got nothing for it).
 */
export function isAiPausedError(error: unknown): error is CapReachedError {
  return error instanceof CapReachedError && error.cap === "monthly_ai_spend";
}

/** Thrown by UsageGuard when a daily cap or the monthly spend cap is reached. */
export class CapReachedError extends Error {
  constructor(
    readonly cap: CapKind,
    readonly limit: number,
    readonly resetsAt: Date,
  ) {
    super(`Usage cap reached: ${cap}`);
    this.name = "CapReachedError";
  }

  toApiException(): ApiException {
    const cap = { kind: this.cap, limit: this.limit, resetsAt: this.resetsAt.toISOString() };
    switch (this.cap) {
      case "items_per_day":
        return new ApiException(
          "daily_cap_reached",
          `You've added ${this.limit} items today, the daily limit while we're testing. Try again tomorrow.`,
          { cap },
        );
      case "outfit_requests_per_day":
        return new ApiException(
          "daily_cap_reached",
          `You've asked for outfits ${this.limit} times today, the daily limit while we're testing. Try again tomorrow.`,
          { cap },
        );
      case "link_fetches_per_day":
        return new ApiException(
          "daily_cap_reached",
          `You've tried ${this.limit} links today, the daily limit while we're testing. You can still add items by photo, or try again tomorrow.`,
          { cap },
        );
      case "emails_per_day":
        return new ApiException(
          "daily_cap_reached",
          `You've forwarded ${this.limit} order emails today, the daily limit while we're testing. Try again tomorrow.`,
          { cap },
        );
      case "shop_searches_per_day":
        return new ApiException(
          "daily_cap_reached",
          `You've searched your shops ${this.limit} times today, the daily limit while we're testing. Try again tomorrow.`,
          { cap },
        );
      case "monthly_ai_spend":
        return new ApiException(
          "ai_paused",
          "Adding items and getting new outfits are paused until next month. Your wardrobe and saved outfits still work.",
          { cap },
        );
    }
  }
}
