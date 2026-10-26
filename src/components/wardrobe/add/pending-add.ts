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
 *
 * Someone else may sign in on the same tab after the session expires, so
 * whatever is kept records whose it is (the signed-in user's ID, passed down
 * from the server page). It's only handed back to that same user, and a
 * draft only if its images are in that user's storage folder (`<userId>/…`).
 * Anything else is thrown away unread.
 */
import { z } from "zod";
import { ItemDraftSchema, ItemTagsSchema, type ItemDraft, type ItemTags } from "@/contracts";
import { SESSION_STORAGE_PREFIX } from "@/lib/client/session-storage";

export const PENDING_ADD_KEY = `${SESSION_STORAGE_PREFIX}pending-add`;
const KEY = PENDING_ADD_KEY;

const StoredPendingAddSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("draft"),
    userId: z.string().min(1),
    draft: ItemDraftSchema,
    cutoutFailed: z.boolean(),
    tags: ItemTagsSchema.nullable(),
  }),
  z.object({ kind: z.literal("photo_lost"), userId: z.string().min(1) }),
]);
type StoredPendingAdd = z.infer<typeof StoredPendingAddSchema>;

/** What the add screen gets back: the kept work, without the owner check's bookkeeping. */
export type PendingAdd =
  | { kind: "draft"; draft: ItemDraft; cutoutFailed: boolean; tags: ItemTags | null }
  | { kind: "photo_lost" };

function write(value: StoredPendingAdd): void {
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(value));
  } catch {
    // Private browsing or storage full: nothing more we can do.
  }
}

/** Keep a draft for `userId`. Without a known user there's no safe way to hand it back, so nothing is kept. */
export function keepDraft(userId: string | null, draft: ItemDraft, cutoutFailed: boolean, tags: ItemTags | null): void {
  if (!userId) return;
  write({ kind: "draft", userId, draft, cutoutFailed, tags });
}

/** Remember that `userId`'s photo was lost, so /add can ask for it again after sign-in. */
export function notePhotoLost(userId: string | null): void {
  if (!userId) return;
  write({ kind: "photo_lost", userId });
}

/**
 * Whose kept add-item work is in storage, without taking it: the stored
 * user ID, or null if nothing (readable) is kept.
 */
export function pendingAddOwner(): string | null {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (raw === null) return null;
    const parsed = StoredPendingAddSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data.userId : null;
  } catch {
    return null;
  }
}

/** True if every image key on the draft is in `userId`'s storage folder. */
function draftBelongsTo(draft: ItemDraft, userId: string): boolean {
  const folder = `${userId}/`;
  return (
    draft.originalImageKey.startsWith(folder) && (draft.cutoutImageKey === null || draft.cutoutImageKey.startsWith(folder))
  );
}

/**
 * Read and forget whatever was kept for `userId` (the signed-in user).
 * Null if nothing was, it's unreadable, or it belongs to someone else; it's
 * deleted from storage in every case. With no known user, storage is left
 * alone, so a brief failure to read the session doesn't lose the draft.
 */
export function takePendingAdd(userId: string | null): PendingAdd | null {
  if (!userId) return null;
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (raw === null) return null;
    window.sessionStorage.removeItem(KEY);
    const parsed = StoredPendingAddSchema.safeParse(JSON.parse(raw));
    if (!parsed.success || parsed.data.userId !== userId) return null;
    const kept = parsed.data;
    if (kept.kind === "photo_lost") return { kind: "photo_lost" };
    if (!draftBelongsTo(kept.draft, userId)) return null;
    return { kind: "draft", draft: kept.draft, cutoutFailed: kept.cutoutFailed, tags: kept.tags };
  } catch {
    return null;
  }
}
