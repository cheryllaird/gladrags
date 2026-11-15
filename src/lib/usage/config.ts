import type { AiCostKind, CappedAction, SpendShare } from "@/contracts";

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
  // Round 2: generated outfit previews (about 3 outfit requests' worth).
  // An identical look reuses its stored image and isn't counted.
  outfit_preview: 12,
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
  // One image-model call for an outfit preview. UNVERIFIED (Google's price
  // page couldn't be reached). The P2 builder priced one image at about
  // 7.8p with headroom, so the estimate is 8p.
  image_generation: 8,
};

/**
 * A settled cost is recorded at most this many pence, for kinds whose
 * bound isn't MAX_SETTLED_COST_MULTIPLE × the estimate. Image generation's
 * estimate is unverified, so it gets its own explicit bound: 20p, two and
 * a half times the 8p estimate (tighter than the default 3×, 24p; still
 * well above the ~7.8p priced cost). A call in flight can take the month
 * past a cap by at most 12p.
 */
export const MAX_SETTLED_COST_PENCE: Readonly<Partial<Record<AiCostKind, number>>> = {
  image_generation: 20,
};

/**
 * Monthly spend shares (round 2): each pauses its own feature once its
 * kinds' month total (all users) reaches the share, while everything else
 * keeps working up to MONTHLY_AI_SPEND_CAP_PENCE. A share isn't set aside:
 * other features can still use the whole £5.
 */
export const MONTHLY_SPEND_SHARES: Readonly<Record<SpendShare, { kinds: readonly AiCostKind[]; capPence: number }>> = {
  // Spec: previews pause on their own at about £2.
  images: { kinds: ["image_generation"], capPence: 200 },
  // Security re-check S1: shop search pauses on its own at about £2 too.
  shop_search: { kinds: ["shop_grounding"], capPence: 200 },
};

/** Which share (if any) each costed kind and each capped action falls under. */
export const SHARE_FOR_COST_KIND: Readonly<Partial<Record<AiCostKind, SpendShare>>> = {
  image_generation: "images",
  shop_grounding: "shop_search",
};
export const SHARE_FOR_ACTION: Readonly<Partial<Record<CappedAction, SpendShare>>> = {
  outfit_preview: "images",
  shop_search: "shop_search",
};

/** Day and month boundaries for caps are in UK time. */
export const USAGE_TIME_ZONE = "Europe/London";
