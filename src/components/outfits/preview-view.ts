/**
 * What an outfit's picture area shows, worked out from the preview the API
 * sent (docs/CONTRACTS.md, section 12) and what this screen is doing with
 * it right now (queued, being asked for, or refused). Pure, unit-tested.
 *
 * Round 2 decision: the generated picture replaces the collage. The collage
 * is the placeholder while the picture is made, and the fallback when it
 * can't be.
 */
import type { Category, OutfitGap, OutfitPreview, PreviewFailureReason } from "@/contracts";
import type { ApiFailure } from "./api";
import { CATEGORY_LABELS, formatResetTime, subcategoryLabel } from "./copy";

/** Why this screen couldn't get a picture, beyond what the outfit's preview says. */
export type PreviewProblem =
  | { kind: "daily_cap"; error: ApiFailure | null }
  | { kind: "paused"; error: ApiFailure | null }
  | { kind: "failed"; error: ApiFailure | null }
  /** Still pending after the polling limit: the collage shows for now. */
  | { kind: "slow" };

/** What the preview runner is doing with one outfit. */
export interface PreviewActivity {
  /** Waiting its turn, or being asked for right now. */
  inProgress: boolean;
  /** Waiting for the user to pick a model figure. */
  awaitingPreset: boolean;
  problem: PreviewProblem | null;
}

export const IDLE_ACTIVITY: PreviewActivity = { inProgress: false, awaitingPreset: false, problem: null };

export type FallbackReason = PreviewProblem["kind"];

export type PreviewView =
  /** The generated picture. `note` says why an update didn't happen (the old picture stays). */
  | {
      kind: "image";
      imageUrl: string;
      outdated: boolean;
      refreshing: boolean;
      note: PreviewNote | null;
    }
  /** The collage as a placeholder while the picture is made. */
  | { kind: "making"; awaitingPreset: boolean }
  /** The collage, with a kind note when there's a reason (none for an outfit that simply has no picture). */
  | { kind: "collage"; note: PreviewNote | null; reason: FallbackReason | null };

export interface PreviewNote {
  title: string;
  message: string;
}

/** A failed or skipped preview's reason as a problem kind. */
function problemKindFor(reason: PreviewFailureReason | null): FallbackReason {
  if (reason === "daily_cap_reached") return "daily_cap";
  if (reason === "ai_paused") return "paused";
  return "failed";
}

/** An API error from the preview route as a problem, or null if it isn't one the card shows. */
export function problemForError(error: ApiFailure): PreviewProblem {
  if (error.code === "daily_cap_reached") return { kind: "daily_cap", error };
  if (error.code === "ai_paused") return { kind: "paused", error };
  return { kind: "failed", error };
}

export function previewView(preview: OutfitPreview, activity: PreviewActivity): PreviewView {
  const problem = activity.problem;
  if (preview.status === "ready" && preview.imageUrl) {
    // The runner gave up on (or was refused) the update: the old picture
    // stays, with Update preview again, whatever the server last said.
    const gaveUp = problem !== null && !activity.inProgress;
    return {
      kind: "image",
      imageUrl: preview.imageUrl,
      outdated: preview.outdated || (gaveUp && preview.refreshing),
      // The runner is asking for the update: show "Updating…" from the tap, not only once the server says so.
      refreshing: !gaveUp && (preview.refreshing || (activity.inProgress && preview.outdated)),
      note: gaveUp ? previewNote(problem, "update") : null,
    };
  }
  if (activity.awaitingPreset) return { kind: "making", awaitingPreset: true };
  if (activity.inProgress) return { kind: "making", awaitingPreset: false };
  if (problem) return { kind: "collage", note: previewNote(problem, "make"), reason: problem.kind };
  if (preview.status === "failed" || preview.status === "skipped") {
    const kind = problemKindFor(preview.failureReason);
    return { kind: "collage", note: previewNote({ kind, error: null } as PreviewProblem, "make"), reason: kind };
  }
  // pending with nothing asking (e.g. before the runner gets to it), or none.
  if (preview.status === "pending") return { kind: "making", awaitingPreset: false };
  return { kind: "collage", note: null, reason: null };
}

/** An update that failed or got stuck: the earlier picture stays, with Update preview. */
const UPDATE_FAILED_NOTE: PreviewNote = {
  title: "Couldn't update the picture",
  message: "Try again later. The earlier picture stays for now.",
};

/**
 * The note under the collage (or under an outdated picture that couldn't be
 * updated). Wording follows the outfit cap notices in copy.ts.
 */
export function previewNote(problem: PreviewProblem, attempt: "make" | "update"): PreviewNote {
  const fallback = attempt === "make" ? "Here are the pieces laid out instead." : "The earlier picture stays for now.";
  switch (problem.kind) {
    case "daily_cap": {
      const cap = problem.error?.cap;
      const limit = cap ? ` (${cap.limit} a day)` : "";
      const resets = cap ? `at ${formatResetTime(cap.resetsAt)}` : "at midnight";
      return {
        title: "That's today's outfit pictures used up",
        message: `You've had today's pictures${limit}. ${fallback} More pictures ${resets}.`,
      };
    }
    case "paused": {
      const cap = problem.error?.cap;
      const until = cap ? ` until ${formatResetTime(cap.resetsAt)}` : " until next month";
      return {
        title: "Outfit pictures are paused for now",
        message: `GladRags has used this month's picture budget, so pictures are paused${until}. ${fallback} Outfit ideas still work.`,
      };
    }
    case "slow":
      if (attempt === "update") return UPDATE_FAILED_NOTE;
      return {
        title: "This picture is taking a while",
        message: "Here are the pieces for now. Come back to this outfit later to see it worn.",
      };
    case "failed":
      if (attempt === "update") return UPDATE_FAILED_NOTE;
      return {
        title: "We couldn't picture this one",
        message: `Sorry, the picture didn't work out this time. ${fallback}`,
      };
  }
}

/** One label per suggested slot (duplicates dropped), keyed by slot. */
export interface SuggestedPiece {
  slot: Category;
  label: string;
}

/**
 * "Trainers suggested", one per suggested slot, so nobody mistakes a
 * generated piece for one they own. Uses the gap's subcategory when the
 * outfit still has that gap, otherwise the slot's name.
 */
export function suggestedPieces(slots: readonly Category[], gaps: readonly OutfitGap[]): SuggestedPiece[] {
  return [...new Set(slots)].map((slot) => {
    const gap = gaps.find((g) => g.category === slot);
    const what = gap?.subcategory ? subcategoryLabel(gap.subcategory) : CATEGORY_LABELS[slot].singular;
    return { slot, label: `${what} suggested` };
  });
}

/** The labels alone, in slot order. */
export function suggestedLabels(slots: readonly Category[], gaps: readonly OutfitGap[]): string[] {
  return suggestedPieces(slots, gaps).map((piece) => piece.label);
}
