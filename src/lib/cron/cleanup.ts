/**
 * The daily cleanup job behind GET /api/cron/cleanup (CONTRACTS.md
 * section 5, "Scheduled jobs"). Vercel Cron calls it once a day (see
 * vercel.json) with `Authorization: Bearer ${CRON_SECRET}`.
 *
 * It runs, in order:
 * - cleanUpOrphanedImages: images over a day old that no item or open
 *   link import uses (unsaved drafts, abandoned imports, failed deletes);
 * - cleanUpOldLinkImports: link_imports rows over 7 days old;
 * - sign_in_attempts rows over a day old (the rate-limit window is 15
 *   minutes).
 *
 * It returns and logs counts only, never keys, emails or other user data.
 */
import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import type { CronCleanupResponse } from "@/contracts";
import { ApiException } from "@/lib/api/errors";
import { SIGN_IN_ATTEMPT_MAX_AGE_MS, type SignInAttemptStore } from "@/lib/auth/rate-limit";
import { cleanUpOrphanedImages } from "@/lib/ingestion/cleanup";
import type { ImageReferences } from "@/lib/ingestion/items-repository";
import type { ImageStorage } from "@/lib/ingestion/storage";
import { cleanUpOldLinkImports } from "@/lib/link-import/cleanup";
import type { LinkImportRepository } from "@/lib/link-import/repository";

export interface CleanupJobDeps {
  storage: ImageStorage;
  references: ImageReferences;
  linkImports: LinkImportRepository;
  signInAttempts: SignInAttemptStore;
  now?: () => Date;
}

const digest = (text: string) => createHash("sha256").update(text).digest();

/**
 * Throws unless the request carries `Authorization: Bearer <secret>`.
 * - No usable secret configured (unset, empty, only whitespace, or with
 *   whitespace around it, which no header can match because header values
 *   are trimmed): server_misconfigured (500), so a bad variable is noticed
 *   and can never leave the job open to anyone.
 * - Anything else: unauthorized (401).
 * The comparison is constant-time (both sides hashed to the same length
 * first), so response timing doesn't leak the secret.
 */
export function assertCronAuthorized(request: Request, secret: string | undefined): void {
  if (!secret || secret.trim() === "" || secret.trim() !== secret) {
    console.error("CRON_SECRET is not set (or is blank or has spaces around it); the scheduled cleanup can't run");
    throw new ApiException("server_misconfigured", "GladRags isn't set up correctly on the server yet");
  }
  const header = request.headers.get("authorization") ?? "";
  if (!timingSafeEqual(digest(header), digest(`Bearer ${secret}`))) {
    throw new ApiException("unauthorized", "Not allowed");
  }
}

export async function runDailyCleanup(deps: CleanupJobDeps): Promise<CronCleanupResponse> {
  const now = deps.now ?? (() => new Date());
  const images = await cleanUpOrphanedImages({ storage: deps.storage, references: deps.references, now });
  const linkImports = await cleanUpOldLinkImports(deps.linkImports, now);
  const signInAttemptsDeleted = await deps.signInAttempts.deleteCreatedBefore(new Date(now().getTime() - SIGN_IN_ATTEMPT_MAX_AGE_MS));
  const result: CronCleanupResponse = {
    imagesChecked: images.checked,
    orphanedImagesDeleted: images.deleted.length,
    linkImportsDeleted: linkImports.deleted,
    signInAttemptsDeleted,
  };
  console.info("Daily cleanup done", result);
  return result;
}
