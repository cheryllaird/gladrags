import type { AiCostKind, CappedAction } from "@/contracts";

/**
 * Cost-control settings (spec: "Cost controls"). The numbers below are
 * suggestions for Cheryl to confirm; real per-call costs get measured in the
 * first tester week, then ESTIMATED_COST_PENCE should be updated.
 */

/** Per-user caps, reset at midnight UK time. */
export const DAILY_CAPS: Readonly<Record<CappedAction, number>> = {
  // Generous enough for a first session photographing a wardrobe
  // (success criterion: 20 items in 15 minutes).
  item_ingest: 40,
  // New requests plus refinements ("swap the shoes", "warmer").
  outfit_request: 25,
  // Add-by-link step 1 attempts (page fetches), fallbacks included. Twice
  // the item cap: room for links that are pasted but never saved.
  link_fetch: 80,
};

/**
 * Total AI spend across all users per calendar month (UK time): £5.
 * Covers Gemini only: background removal runs on the phone for free.
 */
export const MONTHLY_AI_SPEND_CAP_PENCE = 500;

/**
 * Estimated cost of one Gemini call, in pence, used when the provider can't
 * report its real cost. Deliberately on the high side.
 */
export const ESTIMATED_COST_PENCE: Readonly<Record<AiCostKind, number>> = {
  tagging: 0.2,
  ranking_shortlist: 0.2,
  ranking_final: 0.5,
};

/** Day and month boundaries for caps are in UK time. */
export const USAGE_TIME_ZONE = "Europe/London";
