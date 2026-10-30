import { z } from "zod";
import { TimestampSchema } from "./common";

/**
 * Rows in the usage_events table (an addition to the spec's four tables).
 *
 * Counted per user per day (the daily caps):
 * - item_ingest: a photo upload, link import or email line item that went
 *   through AI processing
 * - outfit_request: a new outfit request or a refinement
 * - link_fetch: an add-by-link step 1, counted before the page is fetched,
 *   so fallbacks count too (no AI runs; it limits how often a user can make
 *   the server fetch pages)
 * - email_import: a forwarded order email that passed the acceptance checks,
 *   counted before the model reads it
 * - shop_search: one "Find in my shops" on an outfit (all its gaps at once)
 *
 * Costed (the £5/month cap on Gemini spend, summed across all users):
 * - tagging, ranking_shortlist, ranking_final
 * - email_extraction: reading the line items out of an order email
 * - shop_grounding: one Gemini call with Google Search grounding for a shop search
 *
 * Background removal runs on the user's phone, so it costs nothing and
 * isn't tracked.
 */
export const USAGE_EVENT_KINDS = [
  "item_ingest",
  "outfit_request",
  "link_fetch",
  "email_import",
  "shop_search",
  "tagging",
  "ranking_shortlist",
  "ranking_final",
  "email_extraction",
  "shop_grounding",
] as const;
export const UsageEventKindSchema = z.enum(USAGE_EVENT_KINDS);
export type UsageEventKind = z.infer<typeof UsageEventKindSchema>;

export const CAPPED_ACTIONS = ["item_ingest", "outfit_request", "link_fetch", "email_import", "shop_search"] as const;
export type CappedAction = (typeof CAPPED_ACTIONS)[number];
export type AiCostKind = Exclude<UsageEventKind, CappedAction>;

const CounterSchema = z.object({ used: z.int().min(0), limit: z.int().min(0) });

/**
 * Response of GET /api/usage, so the UI can show "12 of 40 items today".
 * Link fetches aren't reported: their limit is a backstop against abuse,
 * and a user who hits it gets a link_fetches_per_day cap error.
 */
export const UsageSummarySchema = z.object({
  itemsToday: CounterSchema,
  outfitRequestsToday: CounterSchema,
  /** Forwarded order emails accepted today. */
  emailsToday: CounterSchema,
  /** "Find in my shops" searches today. */
  shopSearchesToday: CounterSchema,
  /** When the daily counters reset (midnight UK time). */
  dailyResetAt: TimestampSchema,
  /** True when the monthly AI (Gemini) spend cap is reached and AI features are paused. */
  aiPaused: z.boolean(),
});
export type UsageSummary = z.infer<typeof UsageSummarySchema>;
