import { isMockMode } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * In mock mode every email is allowed except ones starting "not-invited",
 * so the UI can show the "not on the list" state without a database.
 */
export const MOCK_NOT_INVITED_PREFIX = "not-invited";

/**
 * Whether this email is on the tester allowlist (public.allowed_emails).
 * The database enforces the same rule when the account is created; this
 * check exists to give a friendly message first.
 */
export async function isEmailAllowed(email: string): Promise<boolean> {
  const normalised = email.trim().toLowerCase();
  if (isMockMode()) return !normalised.startsWith(MOCK_NOT_INVITED_PREFIX);

  const { data, error } = await createAdminClient().rpc("is_email_allowed", { p_email: normalised });
  if (error) throw new Error(`Couldn't check the allowlist: ${error.message}`);
  return data === true;
}
