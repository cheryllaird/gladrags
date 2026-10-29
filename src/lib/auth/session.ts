import { unstable_rethrow } from "next/navigation";
import { unauthorized } from "@/lib/api/errors";
import { isMockMode } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";

export interface SessionUser {
  id: string;
  email: string;
}

/** The pretend user every request runs as in mock mode. */
export const MOCK_USER: SessionUser = {
  id: "0a000000-0000-4000-8000-000000000001",
  email: "mock.user@gladrags.test",
};

/** The signed-in user, or null. Verified with Supabase, not just read from the cookie. */
export async function getSessionUser(): Promise<SessionUser | null> {
  if (isMockMode()) return MOCK_USER;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email) return null;
  return { id: user.id, email: user.email };
}

/**
 * For pages that can render without knowing the user: the signed-in user, or
 * null if it can't be read. Next.js's own signals are re-thrown, above all the
 * one cookies() throws at build time to mark the page dynamic. Swallowing that
 * made Next pre-render the page once, with no user, for everyone.
 */
export async function getSessionUserOrNull(): Promise<SessionUser | null> {
  try {
    return await getSessionUser();
  } catch (error) {
    unstable_rethrow(error);
    return null;
  }
}

/** Use at the top of every API route. Throws an `unauthorized` ApiException. */
export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) throw unauthorized();
  return user;
}
