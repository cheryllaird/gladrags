// Daily cleanup (orchestrator, milestone 4). Vercel Cron calls this once a
// day (vercel.json) with `Authorization: Bearer ${CRON_SECRET}`; anything
// else is refused. See src/lib/cron/cleanup.ts for what it deletes.
//
// It isn't behind sign-in (no user is involved), and the proxy skips it.
import { CronCleanupResponseSchema } from "@/contracts";
import { jsonResponse, withApiHandler } from "@/lib/api/http";
import { assertCronAuthorized, runDailyCleanup } from "@/lib/cron/cleanup";
import { getCleanupJobDeps } from "@/lib/cron/deps";

/** Listing and deleting objects in two buckets can take a while. */
export const maxDuration = 60;

export const GET = withApiHandler(async (request) => {
  assertCronAuthorized(request, process.env.CRON_SECRET);
  return jsonResponse(CronCleanupResponseSchema, await runDailyCleanup(getCleanupJobDeps()));
});
