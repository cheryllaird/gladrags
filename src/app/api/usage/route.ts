// Real implementation (foundations): today's counts against the daily caps,
// and whether AI features are paused by the monthly spend cap.
import { UsageSummarySchema } from "@/contracts";
import { jsonResponse, withApiHandler } from "@/lib/api/http";
import { requireUser } from "@/lib/auth/session";
import { getUsageGuard } from "@/lib/usage";

export const GET = withApiHandler(async () => {
  const user = await requireUser();
  return jsonResponse(UsageSummarySchema, await getUsageGuard().summary(user.id));
});
