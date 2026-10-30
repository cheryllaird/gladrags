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
  // Forwarded order emails accepted. Each can add several items, which
  // also count against item_ingest.
  email_import: 10,
  // "Find in my shops" on an outfit (all its gaps in one search). Grounded
  // searches cost more than ranking, so the cap is low.
  shop_search: 10,
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
  // Reading an order email's text (up to ~25k tokens in, a short JSON reply).
  email_extraction: 0.5,
  // One Gemini call with Google Search grounding. A GUESS until measured:
  // Google bills grounding per search query on top of tokens (roughly
  // 1p-3p a query at list prices, and one call can make several queries),
  // so this is set high.
  shop_grounding: 3,
};

/** Day and month boundaries for caps are in UK time. */
export const USAGE_TIME_ZONE = "Europe/London";
