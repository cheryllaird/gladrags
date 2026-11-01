import { BATCH_STAGE_LABELS, summariseBatch, type BatchEntryState } from "@/lib/client/add-item";
import { errorCopy, type ErrorCopy } from "../api-error-notice";

export type BatchKind = "photo" | "link";

const NOUNS: Record<BatchKind, [string, string]> = { photo: ["photo", "photos"], link: ["link", "links"] };

export function plural(count: number, kind: BatchKind): string {
  const [one, many] = NOUNS[kind];
  return `${count} ${count === 1 ? one : many}`;
}

export interface BatchSummaryCopy {
  title: string;
  lines: string[];
  /** Set when the batch stopped early (daily cap, AI paused, signed out, offline). */
  stopped: ErrorCopy["kind"] | null;
}

/** What the end-of-batch summary says. */
export function batchSummaryCopy(kind: BatchKind, states: readonly BatchEntryState[], stoppedBy: unknown): BatchSummaryCopy {
  const s = summariseBatch(states);
  const lines: string[] = [];
  let title: string;
  let stopped: BatchSummaryCopy["stopped"] = null;

  if (stoppedBy) {
    const copy = errorCopy(stoppedBy);
    stopped = copy.kind;
    title = copy.title;
    const added = s.saved === 1 ? "1 was added" : `${s.saved} were added`;
    lines.push(`${added} before it stopped; the other ${plural(s.notAdded, kind)} weren't.`);
    lines.push(copy.message);
  } else {
    title = s.saved === s.total ? `All ${plural(s.total, kind)} added` : "Done";
  }

  if (!stoppedBy && s.saved > 0) {
    lines.push(`${s.saved === 1 ? "1 item is" : `${s.saved} items are`} in your wardrobe, marked to review.`);
  }
  if (s.drafts > 0) {
    lines.push(`${s.drafts === 1 ? "1 couldn't" : `${s.drafts} couldn't`} be tagged automatically: fill in the tags in the review list.`);
  }
  if (s.needsScreenshot > 0) {
    lines.push(`${plural(s.needsScreenshot, "link")} need${s.needsScreenshot === 1 ? "s" : ""} a screenshot: the site couldn't be read. Add them below.`);
  }
  if (s.failed > 0) {
    lines.push(`${s.failed === 1 ? "1" : s.failed} couldn't be added (see below).`);
  }
  return { title, lines, stopped };
}

/** One row's status, in a few words. */
export function batchEntryLabel(state: BatchEntryState): string {
  switch (state.kind) {
    case "pending":
      return state.stage === "waiting" ? BATCH_STAGE_LABELS.waiting : `${BATCH_STAGE_LABELS[state.stage]}…`;
    case "saved":
      return `Added: ${state.item.tags.description}`;
    case "draft":
      return "Couldn't be tagged: fill in the tags";
    case "needs_screenshot":
      return state.message;
    case "failed":
      return errorCopy(state.error).message;
    case "not_added":
      return "Not added";
  }
}
