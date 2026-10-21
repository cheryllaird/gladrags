import { z } from "zod";

/**
 * Environment variables that are safe anywhere (server or browser),
 * validated when first used (not at import time) so `pnpm build` and the
 * unit tests work without any secrets. See .env.example.
 *
 * The Supabase secret key is in env.server.ts, which can't be imported
 * from client code.
 */

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * Mock mode: API routes serve in-memory mock data, auth is skipped (everyone
 * is MOCK_USER) and AI providers are fakes. For UI work and tests without
 * Supabase or AI keys.
 *
 * Because mock mode turns sign-in off, it refuses to run (ConfigError) when:
 * - deployed on Vercel (VERCEL_ENV is set, preview or production), or
 * - a production build is running (`next start`), unless GLADRAGS_E2E=true
 *   says this is a local or CI end-to-end test run.
 */
export function isMockMode(): boolean {
  if (process.env.GLADRAGS_MOCK_MODE !== "true") return false;
  if (process.env.VERCEL_ENV) {
    throw new ConfigError("GLADRAGS_MOCK_MODE=true is not allowed on Vercel: it turns sign-in off.");
  }
  if (process.env.NODE_ENV === "production" && process.env.GLADRAGS_E2E !== "true") {
    throw new ConfigError(
      "GLADRAGS_MOCK_MODE=true is not allowed in a production build. For end-to-end tests, also set GLADRAGS_E2E=true.",
    );
  }
  return true;
}

export function parseEnv<T extends z.ZodType>(
  schema: T,
  source: Record<string, string | undefined>,
  what: string,
): z.infer<T> {
  const result = schema.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new ConfigError(`${what} is not configured. Check: ${problems}. See .env.example.`);
  }
  return result.data;
}

export const SupabasePublicEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  /** New-style publishable key (sb_publishable_...). Browser-safe; RLS applies. Not a JWT. */
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
});
export type SupabasePublicEnv = z.infer<typeof SupabasePublicEnvSchema>;

/**
 * Supabase URL and publishable key. The variables are read by their literal
 * names so Next.js inlines them into client bundles.
 */
export function getSupabasePublicEnv(): SupabasePublicEnv {
  return parseEnv(
    SupabasePublicEnvSchema,
    {
      NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    },
    "Supabase",
  );
}

export function hasSupabaseEnv(): boolean {
  try {
    getSupabasePublicEnv();
    return true;
  } catch {
    return false;
  }
}

/**
 * Public base URL for links in emails (the magic link). Falls back to the
 * request's origin when NEXT_PUBLIC_SITE_URL isn't set.
 */
export function getSiteUrl(requestOrigin: string): string {
  const fromEnv = process.env.NEXT_PUBLIC_SITE_URL;
  return fromEnv && z.url().safeParse(fromEnv).success ? fromEnv.replace(/\/$/, "") : requestOrigin;
}
