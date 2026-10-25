import { NextResponse, type NextRequest } from "next/server";
import { hasSupabaseEnv, isMockMode } from "@/lib/env";
import { updateSession } from "@/lib/supabase/proxy";

/**
 * Runs before every page and API request (Next.js 16 "proxy", formerly
 * middleware). Refreshes the Supabase session, and sends signed-out visitors
 * to /sign-in. API routes are not redirected: they return 401 themselves
 * via requireUser().
 */

/** Paths that don't need a signed-in user. */
const PUBLIC_PATHS = ["/sign-in", "/auth/", "/api/auth/", "/offline.html"];

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p.endsWith("/") ? p : `${p}/`));
}

export async function proxy(request: NextRequest) {
  if (isMockMode()) return NextResponse.next();

  if (!hasSupabaseEnv()) {
    return new NextResponse(
      "GladRags isn't configured: set the Supabase variables from .env.example, or GLADRAGS_MOCK_MODE=true for local UI work.",
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
