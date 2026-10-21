import { z } from "zod";
import { IdSchema, TimestampSchema, singleLineText } from "./common";
import { GuidanceSchema } from "./outfit";

export const FEEDBACK_KINDS = ["swap", "guidance", "reject"] as const;
export const FeedbackKindSchema = z.enum(FEEDBACK_KINDS);
export type FeedbackKind = z.infer<typeof FeedbackKindSchema>;

export const REJECT_REASON_MAX_LENGTH = 200;

/**
 * Body of POST /api/outfits/[id]/refine. Either tap "swap" on one item, or
 * type guidance ("warmer", "less formal"). Returns a revised set of outfits.
 */
export const RefineRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("swap"), itemId: IdSchema }),
  z.object({ kind: z.literal("guidance"), text: GuidanceSchema }),
]);
export type RefineRequest = z.infer<typeof RefineRequestSchema>;

/**
 * Body of PATCH /api/outfits/[id]: save, like or reject an outfit.
 * Rejecting also records an outfit_feedback row (kind "reject") so the
 * engine can send the item pairings as "avoid" hints later.
 */
export const UpdateOutfitStatusRequestSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("suggested") }),
  z.object({ status: z.literal("saved") }),
  z.object({ status: z.literal("liked") }),
  z.object({
    status: z.literal("rejected"),
    /** Optional "why not" from the user. */
    reason: singleLineText(REJECT_REASON_MAX_LENGTH).optional(),
  }),
]);
export type UpdateOutfitStatusRequest = z.infer<typeof UpdateOutfitStatusRequestSchema>;

/**
 * One outfit_feedback row. `detail` holds:
 * - swap: the ID of the item the user wanted swapped out
 * - guidance: the guidance text
 * - reject: the user's reason, or null
 */
export const OutfitFeedbackSchema = z.discriminatedUnion("kind", [
  z.object({ id: IdSchema, outfitId: IdSchema, kind: z.literal("swap"), detail: IdSchema, createdAt: TimestampSchema }),
  z.object({ id: IdSchema, outfitId: IdSchema, kind: z.literal("guidance"), detail: GuidanceSchema, createdAt: TimestampSchema }),
  z.object({
    id: IdSchema,
    outfitId: IdSchema,
    kind: z.literal("reject"),
    detail: singleLineText(REJECT_REASON_MAX_LENGTH).nullable(),
    createdAt: TimestampSchema,
  }),
]);
export type OutfitFeedback = z.infer<typeof OutfitFeedbackSchema>;
