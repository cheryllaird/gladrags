import { NextResponse, type NextRequest } from "next/server";
import { isMockMode, supabaseEnvProblem } from "@/lib/env";
import { updateSession } from "@/lib/supabase/proxy";

/**
 * Runs before every page and API request (Next.js 16 "proxy", formerly
 * middleware). Refreshes the Supabase session, and sends signed-out visitors
 * to /sign-in. API routes are not redirected: they return 401 themselves
 * via requireUser().
 */

/** Paths that don't need a signed-in user, along with everything under them. */
const PUBLIC_PATHS = ["/sign-in", "/auth/", "/api/auth/", "/offline.html"];

/** Single pages that don't need a signed-in user: only the exact path, nothing under it. */
const PUBLIC_EXACT_PATHS = ["/privacy"];

function isPublic(pathname: string): boolean {
  if (PUBLIC_EXACT_PATHS.includes(pathname)) return true;
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p.endsWith("/") ? p : `${p}/`));
}

/**
 * Routes no signed-in user calls, so there's no session to refresh:
 * scheduled jobs (Vercel Cron, with a bearer secret the route checks), the
 * browser's own CSP reports, and the inbound email service's webhook
 * (which checks the provider's signature itself).
 */
const SESSIONLESS_PREFIXES = ["/api/cron/", "/api/csp-report", "/api/inbound/"];

export async function proxy(request: NextRequest) {
  if (isMockMode()) return NextResponse.next();
  if (SESSIONLESS_PREFIXES.some((prefix) => request.nextUrl.pathname.startsWith(prefix))) return NextResponse.next();

  const configProblem = supabaseEnvProblem();
  if (configProblem) {
    // Names the variables at fault (not their values), so a deployment's
    // settings can be fixed without guessing.
    return new NextResponse(
      `GladRags isn't configured. ${configProblem} For local UI work without Supabase, set GLADRAGS_MOCK_MODE=true.`,
      { status: 500, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }

  const { response, user } = await updateSession(request);
  const { pathname, search } = request.nextUrl;

  if (!user && !pathname.startsWith("/api/") && !isPublic(pathname)) {
    const signIn = request.nextUrl.clone();
    signIn.pathname = "/sign-in";
    signIn.search = "";
    if (pathname !== "/") signIn.searchParams.set("next", `${pathname}${search}`);
    return NextResponse.redirect(signIn);
  }

  return response;
}

export const config = {
  matcher: [
    // Everything except static files, images, the PWA files, mock assets and
    // the background-removal model and runtime (public files, src/lib/images).
    "/((?!_next/static|_next/image|favicon.ico|icons/|mock/|models/|ort/|sw.js|manifest.webmanifest|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
