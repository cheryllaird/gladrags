import { isMockMode } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { UsageGuard } from "./guard";
import { InMemoryUsageStore, SupabaseUsageStore } from "./store";

export * from "./config";
export { CapReachedError, isAiPausedError } from "./errors";
export { UsageGuard, DEFAULT_USAGE_LIMITS, MAX_SETTLED_COST_MULTIPLE, type AiCallMeter, type MeteredCall, type UsageLimits, type UsageReservation } from "./guard";
export { InMemoryUsageStore, SupabaseUsageStore, type UsageEvent, type UsageReservationRequest, type UsageReservationResult, type UsageStore } from "./store";

// Kept on globalThis so the in-memory store survives dev-server hot reloads.
const globalForUsage = globalThis as unknown as { __gladragsMockUsage?: InMemoryUsageStore };

/** The usage guard for the current environment: in-memory in mock mode, Supabase otherwise. */
export function getUsageGuard(): UsageGuard {
  if (isMockMode()) {
    // End-to-end runs share one mock user across many parallel test files, so
    // a shared counter would hit the daily caps part-way through the suite.
    // Give each request a fresh counter instead; cap behaviour is covered by
    // unit tests and the mock-daily-cap / mock-ai-paused markers.
    if (process.env.GLADRAGS_E2E === "true") {
      return new UsageGuard(new InMemoryUsageStore());
    }
    globalForUsage.__gladragsMockUsage ??= new InMemoryUsageStore();
    return new UsageGuard(globalForUsage.__gladragsMockUsage);
  }
  return new UsageGuard(new SupabaseUsageStore(createAdminClient()));
}
