/**
 * The real settings repository, outside mock mode: the signed-in user's
 * client, so RLS applies. Tests replace this module (vi.mock).
 */
import "server-only";
import { createClient } from "@/lib/supabase/server";
import { SupabaseSettingsRepository, type SettingsRepository } from "./repository";

export async function getSettingsRepository(): Promise<SettingsRepository> {
  return new SupabaseSettingsRepository(await createClient());
}
