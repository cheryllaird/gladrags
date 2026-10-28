import type { CookieOptionsWithName } from "@supabase/ssr";

/**
 * Options for the Supabase session cookies, used by both server clients
 * (src/lib/supabase/server.ts and proxy.ts).
 *
 * - httpOnly: page scripts can't read the session, so an XSS bug can't
 *   steal it. Nothing in the browser needs it: the UI only calls our own
 *   API routes, which read the cookie on the server.
 * - secure in production: only sent over HTTPS.
 * - sameSite lax: not sent on cross-site POSTs (the CSRF checks in
 *   src/lib/api/http.ts back this up).
 */
export function sessionCookieOptions(): CookieOptionsWithName {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
  };
}
