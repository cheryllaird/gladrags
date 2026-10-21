"use client";

import { createBrowserClient } from "@supabase/ssr";
import { getSupabasePublicEnv } from "@/lib/env";

/**
 * Supabase client for Client Components. Prefer calling our own API routes
 * from the UI; use this only for things like listening to auth changes.
 */
export function createClient() {
  const env = getSupabasePublicEnv();
  return createBrowserClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY);
}
