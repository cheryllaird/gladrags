/**
 * Clearing out old link_imports rows. Their images are handled by
 * ingestion's cleanUpOrphanedImages (src/lib/ingestion/cleanup.ts): an
 * import's image is kept while the import can still be finished
 * (LINK_IMPORT_TTL_SECONDS), and removed once it's a day old if no saved
 * item uses it. The rows themselves (source URL and product text) aren't
 * needed after that, so delete them on the same schedule.
 */
import "server-only";
import type { LinkImportRepository } from "./repository";

/** Rows older than this are deleted. Well past the 1-hour limit for step 2. */
export const LINK_IMPORT_ROW_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export async function cleanUpOldLinkImports(
  linkImports: LinkImportRepository,
  now: () => Date = () => new Date(),
): Promise<{ deleted: number }> {
  const deleted = await linkImports.deleteCreatedBefore(new Date(now().getTime() - LINK_IMPORT_ROW_MAX_AGE_MS));
  return { deleted };
}
