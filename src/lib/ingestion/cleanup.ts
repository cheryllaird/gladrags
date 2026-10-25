/**
 * Orphaned-image cleanup.
 *
 * Images are stored as soon as a photo is uploaded, but the item row only
 * exists once the user saves the draft. A draft that's never saved (the
 * user backs out, the app is closed) leaves its images behind. So do failed
 * deletes and abandoned add-by-link imports.
 *
 * cleanUpOrphanedImages() deletes images that are older than `minAgeMs` and
 * that no item uses (and no add-by-link import can still use). Run it on a
 * schedule (e.g. daily) with the admin client, from a protected route or a
 * Supabase scheduled function; wiring the schedule up is an integration task.
 *
 *   await cleanUpOrphanedImages({
 *     storage: new SupabaseImageStorage(createAdminClient()),
 *     references: new SupabaseImageReferences(createAdminClient()),
 *   });
 *
 * The minimum age protects drafts still being reviewed: a draft's signed
 * URLs last an hour, so anything a day old is safe to remove.
 */
import "server-only";
import { STORAGE_BUCKETS } from "@/contracts";
import type { ImageReferences } from "./items-repository";
import type { ImageBucket, ImageStorage } from "./storage";

export const ORPHAN_MIN_AGE_MS = 24 * 60 * 60 * 1000;

/** Keys per reference lookup, to keep query URLs short. */
const BATCH_SIZE = 50;

export interface CleanupDeps {
  storage: ImageStorage;
  references: ImageReferences;
  now?: () => Date;
}

export interface CleanupOptions {
  minAgeMs?: number;
  /** Report what would be deleted without deleting anything. */
  dryRun?: boolean;
}

export interface CleanupReport {
  checked: number;
  deleted: { bucket: ImageBucket; key: string }[];
}

export async function cleanUpOrphanedImages(
  { storage, references, now = () => new Date() }: CleanupDeps,
  { minAgeMs = ORPHAN_MIN_AGE_MS, dryRun = false }: CleanupOptions = {},
): Promise<CleanupReport> {
  const cutoff = now().getTime() - minAgeMs;
  const report: CleanupReport = { checked: 0, deleted: [] };

  for (const bucket of Object.values(STORAGE_BUCKETS)) {
    for (const folder of await storage.listFolders(bucket)) {
      const old = (await storage.listObjects(bucket, folder)).filter((o) => o.createdAt.getTime() < cutoff);
      report.checked += old.length;
      for (let i = 0; i < old.length; i += BATCH_SIZE) {
        const keys = old.slice(i, i + BATCH_SIZE).map((o) => o.key);
        const keep = await references.referenced(keys);
        const orphans = keys.filter((key) => !keep.has(key));
        if (orphans.length === 0) continue;
        if (!dryRun) await storage.remove(bucket, orphans);
        report.deleted.push(...orphans.map((key) => ({ bucket, key })));
      }
    }
  }
  return report;
}
