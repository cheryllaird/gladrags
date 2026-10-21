import { z } from "zod";
import { TimestampSchema } from "./common";

/**
 * Rows in the usage_events table (an addition to the spec's four tables).
 *
 * Counted per user per day (the daily caps):
 * - item_ingest: a photo upload or link import that went through AI processing
 * - outfit_request: a new outfit request or a refinement
 *
 * Costed (the £5/month cap on Gemini spend, summed across all users):
 * - tagging, ranking_shortlist, ranking_final
 *
 * Background removal runs on the user's phone, so it costs nothing and
 * isn't tracked.
 */
export const USAGE_EVENT_KINDS = [
  "item_ingest",
  "outfit_request",
  "tagging",
  "ranking_shortlist",
  "ranking_final",
] as const;
export const UsageEventKindSchema = z.enum(USAGE_EVENT_KINDS);
export type UsageEventKind = z.infer<typeof UsageEventKindSchema>;

export type CappedAction = "item_ingest" | "outfit_request";
export type AiCostKind = Exclude<UsageEventKind, CappedAction>;

const CounterSchema = z.object({ used: z.int().min(0), limit: z.int().min(0) });

/** Response of GET /api/usage, so the UI can show "12 of 30 items today". */
export const UsageSummarySchema = z.object({
  itemsToday: CounterSchema,
  outfitRequestsToday: CounterSchema,
  /** When the daily counters reset (midnight UK time). */
  dailyResetAt: TimestampSchema,
  /** True when the monthly AI (Gemini) spend cap is reached and AI features are paused. */
  aiPaused: z.boolean(),
});
export type UsageSummary = z.infer<typeof UsageSummarySchema>;
