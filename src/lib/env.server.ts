// Importing this from a Client Component fails the build: the secret key
// must never reach the browser.
import "server-only";
import { z } from "zod";
import { SupabasePublicEnvSchema, parseEnv } from "./env";

const SupabaseSecretEnvSchema = SupabasePublicEnvSchema.extend({
  /** New-style secret key (sb_secret_...). Server only; bypasses RLS. Not a JWT. */
  SUPABASE_SECRET_KEY: z.string().min(1),
});
export type SupabaseSecretEnv = z.infer<typeof SupabaseSecretEnvSchema>;

export function getSupabaseSecretEnv(): SupabaseSecretEnv {
  return parseEnv(
    SupabaseSecretEnvSchema,
    {
      NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
      SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY,
    },
    "Supabase secret key",
  );
}
