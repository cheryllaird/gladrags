import "server-only";
import { createClient } from "@supabase/supabase-js";
import { getSupabaseSecretEnv } from "@/lib/env.server";

/**
 * Supabase client using the secret key (sb_secret_...). SERVER ONLY. It
 * bypasses row-level security (it acts as the service_role database role),
 * so every query must filter by the signed-in user's ID itself. Use it only
 * for: the allowlist check, usage tracking, signed URLs and storage writes,
 * and account deletion.
 */
export function createAdminClient() {
  const env = getSupabaseSecretEnv();
  return createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
