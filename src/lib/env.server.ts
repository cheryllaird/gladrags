// Importing this from a Client Component fails the build: the secret key
// must never reach the browser.
import "server-only";
import { z } from "zod";
import type { ForwardingAddressConfig } from "@/contracts";
import { SupabasePublicEnvSchema, isMockMode, parseEnv } from "./env";

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

// ---------------------------------------------------------------------------
// Order email forwarding (milestone 5)
// ---------------------------------------------------------------------------

/** Used for forwarding addresses in mock mode when INBOUND_EMAIL_DOMAIN isn't set. */
export const MOCK_INBOUND_EMAIL_DOMAIN = "inbound.gladrags.test";

const InboundEmailEnvSchema = z.object({
  INBOUND_EMAIL_DOMAIN: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/)
    .optional(),
  INBOUND_EMAIL_PREFIX: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9._+-]{0,40}$/)
    .optional(),
});

/**
 * Where forwarding addresses live (see forwardingAddress in
 * src/contracts/email.ts), or null when INBOUND_EMAIL_DOMAIN isn't set:
 * the app then shows no address. In mock mode an unset domain uses
 * MOCK_INBOUND_EMAIL_DOMAIN. A malformed value is a ConfigError.
 */
export function getForwardingAddressConfig(): ForwardingAddressConfig | null {
  const env = parseEnv(
    InboundEmailEnvSchema,
    {
      INBOUND_EMAIL_DOMAIN: process.env.INBOUND_EMAIL_DOMAIN || undefined,
      INBOUND_EMAIL_PREFIX: process.env.INBOUND_EMAIL_PREFIX || undefined,
    },
    "Inbound email",
  );
  const domain = env.INBOUND_EMAIL_DOMAIN ?? (isMockMode() ? MOCK_INBOUND_EMAIL_DOMAIN : undefined);
  if (!domain) return null;
  return { domain, prefix: env.INBOUND_EMAIL_PREFIX ?? "" };
}

/**
 * The shared secret the inbound email webhook checks the provider's
 * signature (or credentials) against. At least 32 characters. Throws
 * ConfigError when missing or too short, so the webhook refuses everything
 * rather than accepting unsigned posts.
 */
export function getInboundWebhookSecret(): string {
  return parseEnv(
    z.object({ INBOUND_EMAIL_WEBHOOK_SECRET: z.string().min(32) }),
    { INBOUND_EMAIL_WEBHOOK_SECRET: process.env.INBOUND_EMAIL_WEBHOOK_SECRET },
    "Inbound email webhook secret",
  ).INBOUND_EMAIL_WEBHOOK_SECRET;
}
