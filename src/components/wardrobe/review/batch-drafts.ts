/**
 * Drafts from a batch add whose tagging failed (CONTRACTS.md section 5:
 * `{ status: "draft" }`). There were no tags to save them with, so they
 * aren't in the wardrobe yet: the review list shows them for the user to
 * fill in and save with POST /api/items.
 *
 * Kept in sessionStorage under the `gladrags:` prefix, so they're cleared
 * with everything else on sign-out, account deletion, or someone else
 * signing in on the tab (session-storage.ts). They record whose they are,
 * and are only handed back to that user, and only if their images are in
 * that user's storage folder. Read back with zod, since storage is outside
 * our control. Every access is wrapped: with storage blocked (private
 * browsing) drafts simply aren't kept between pages.
 *
 * A draft's picture is a signed URL that lasts an hour (CONTRACTS.md
 * section 2), and nothing re-signs it: a draft isn't an item, so there's
 * no route to fetch it again. Drafts are therefore dropped after
 * BATCH_DRAFT_MAX_AGE_MS, a little under the hour, rather than shown with a
 * broken picture. (The images themselves are cleaned up a day after upload
 * if never saved.) A picture that fails sooner anyway is shown as expired,
 * with Discard (review-screen.tsx).
 */
import { z } from "zod";
import { ItemDraftSchema, type ItemDraft } from "@/contracts";
import { MAX_BATCH_SIZE } from "@/lib/client/add-item";
import { SESSION_STORAGE_PREFIX } from "@/lib/client/session-storage";
import { notifyStorageChange } from "@/lib/client/use-storage-value";

export const BATCH_DRAFTS_KEY = `${SESSION_STORAGE_PREFIX}batch-drafts`;

/** Drop drafts before their one-hour signed picture URL expires. */
export const BATCH_DRAFT_MAX_AGE_MS = 55 * 60 * 1000;

/** Most drafts kept: two batches' worth. */
const MAX_KEPT = MAX_BATCH_SIZE * 2;

const StoredSchema = z.object({
  userId: z.string().min(1),
  drafts: z.array(z.object({ draft: ItemDraftSchema, addedAt: z.number() })).max(MAX_KEPT),
});
type Stored = z.infer<typeof StoredSchema>;

function belongsTo(draft: ItemDraft, userId: string): boolean {
  const folder = `${userId}/`;
  return draft.originalImageKey.startsWith(folder) && (draft.cutoutImageKey === null || draft.cutoutImageKey.startsWith(folder));
}

function parse(raw: string | null | undefined, userId: string, now: number): Stored["drafts"] {
  if (!raw) return [];
  try {
    const parsed = StoredSchema.safeParse(JSON.parse(raw));
    if (!parsed.success || parsed.data.userId !== userId) return [];
    return parsed.data.drafts.filter((d) => belongsTo(d.draft, userId) && now - d.addedAt < BATCH_DRAFT_MAX_AGE_MS);
  } catch {
    return [];
  }
}

function read(userId: string, now: number): Stored["drafts"] {
  try {
    return parse(window.sessionStorage.getItem(BATCH_DRAFTS_KEY), userId, now);
  } catch {
    return [];
  }
}

function write(userId: string, drafts: Stored["drafts"]): void {
  try {
    if (drafts.length === 0) window.sessionStorage.removeItem(BATCH_DRAFTS_KEY);
    else window.sessionStorage.setItem(BATCH_DRAFTS_KEY, JSON.stringify({ userId, drafts: drafts.slice(-MAX_KEPT) }));
  } catch {
    // Storage blocked or full: the batch summary still shows the draft on the add screen.
  }
  notifyStorageChange();
}

/** The signed-in user's batch drafts, oldest first. Empty without a known user. */
export function readBatchDrafts(userId: string | null, now: number = Date.now()): ItemDraft[] {
  if (!userId) return [];
  return read(userId, now).map((d) => d.draft);
}

/** The same, from the stored string (what useStorageValue("session", BATCH_DRAFTS_KEY) returns). */
export function batchDraftsFromRaw(raw: string | null | undefined, userId: string | null, now: number = Date.now()): ItemDraft[] {
  if (!userId) return [];
  return parse(raw, userId, now).map((d) => d.draft);
}

/**
 * Keep a draft to fill in later. Returns false if it couldn't be kept (no
 * known user, or storage blocked or full): the batch screen then offers the
 * fill-in straight away.
 */
export function keepBatchDraft(userId: string | null, draft: ItemDraft, now: number = Date.now()): boolean {
  if (!userId || !belongsTo(draft, userId)) return false;
  const drafts = read(userId, now).filter((d) => d.draft.originalImageKey !== draft.originalImageKey);
  write(userId, [...drafts, { draft, addedAt: now }]);
  return read(userId, now).some((d) => d.draft.originalImageKey === draft.originalImageKey);
}

/** Forget a draft once it's saved or discarded. */
export function removeBatchDraft(userId: string | null, originalImageKey: string, now: number = Date.now()): void {
  if (!userId) return;
  write(
    userId,
    read(userId, now).filter((d) => d.draft.originalImageKey !== originalImageKey),
  );
}
