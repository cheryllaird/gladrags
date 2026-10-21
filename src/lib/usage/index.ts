import { isMockMode } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { UsageGuard } from "./guard";
import { InMemoryUsageStore, SupabaseUsageStore } from "./store";

export * from "./config";
export { CapReachedError } from "./errors";
export { UsageGuard, DEFAULT_USAGE_LIMITS, type UsageLimits } from "./guard";
export { InMemoryUsageStore, SupabaseUsageStore, type UsageStore, type UsageEvent } from "./store";

// Kept on globalThis so the in-memory store survives dev-server hot reloads.
const globalForUsage = globalThis as unknown as { __gladragsMockUsage?: InMemoryUsageStore };

/** The usage guard for the current environment: in-memory in mock mode, Supabase otherwise. */
export function getUsageGuard(): UsageGuard {
  if (isMockMode()) {
    globalForUsage.__gladragsMockUsage ??= new InMemoryUsageStore();
    return new UsageGuard(globalForUsage.__gladragsMockUsage);
  }
  return new UsageGuard(new SupabaseUsageStore(createAdminClient()));
}
