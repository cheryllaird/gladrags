/**
 * What the add flow keeps when the session expires mid-add, so signing in
 * again doesn't silently lose the user's work.
 *
 * - The photo was uploaded and tagged, but saving failed: keep the draft
 *   (its images are already stored under the user's own folder) and the
 *   tags as the user left them. After sign-in, /add reopens the review.
 * - The upload itself failed: the photo is only in the page's memory and
 *   too big to keep, so remember to tell the user to choose it again.
 *
 * Kept in sessionStorage: it survives the same-tab trip through /sign-in
 * (including in the installed iPhone app) and goes when the tab closes.
 * Read back with zod, since storage is outside our control.
 */
import { z } from "zod";
import { ItemDraftSchema, ItemTagsSchema, type ItemDraft, type ItemTags } from "@/contracts";

const KEY = "gladrags:pending-add";

const PendingAddSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("draft"),
    draft: ItemDraftSchema,
    cutoutFailed: z.boolean(),
    tags: ItemTagsSchema.nullable(),
  }),
  z.object({ kind: z.literal("photo_lost") }),
]);
export type PendingAdd = z.infer<typeof PendingAddSchema>;

function write(value: PendingAdd): void {
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(value));
  } catch {
    // Private browsing or storage full: nothing more we can do.
  }
}

export function keepDraft(draft: ItemDraft, cutoutFailed: boolean, tags: ItemTags | null): void {
  write({ kind: "draft", draft, cutoutFailed, tags });
}

export function notePhotoLost(): void {
  write({ kind: "photo_lost" });
}

/** Read and forget whatever was kept. Null if nothing was, or it's unreadable. */
export function takePendingAdd(): PendingAdd | null {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (raw === null) return null;
    window.sessionStorage.removeItem(KEY);
    const parsed = PendingAddSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
