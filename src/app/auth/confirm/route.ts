// Magic-link landing for a customised email template that links to
// /auth/confirm?token_hash={{ .TokenHash }}&type=email&next=/path.
// Unlike /auth/callback this works in any browser, not only the one that
// asked for the link. See docs/CONTRACTS.md, "Sign-in".
//
// Signing in takes a POST:
// - GET (the emailed link) only shows a small "Continue signing in" page
//   whose form posts the token back. Mail scanners and link previews that
//   fetch the link can't use up the one-time token, and another site can't
//   sign someone in by embedding the link (a GET changes nothing).
// - POST, from that form on this site (the Origin is checked), verifies
//   the token and signs in.
// Typing the emailed code (POST /api/auth/verify-code) is unchanged, so
// the iPhone home-screen app keeps working.
//
// The page uses the site-wide Referrer-Policy (strict-origin-when-cross-
// origin), so its form POST carries the token_hash in a same-origin Referer
// only. That token is single-use and that same POST consumes it. A
// route-level `no-referrer` would make browsers send `Origin: null` on the
// POST, which the CSRF check would have to special-case.
//
// In mock mode (no Supabase) the POST skips verification, like every mock
// sign-in, and goes straight to `next`.
import type { EmailOtpType } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { isCrossSiteRequest } from "@/lib/api/http";
import { isMockMode } from "@/lib/env";
import { safeReturnPath } from "@/lib/auth/redirect";
import { createClient } from "@/lib/supabase/server";

const ALLOWED_TYPES: readonly EmailOtpType[] = ["email", "magiclink", "signup"];

/** A token hash from Supabase is hex; anything else is refused before it reaches the page. */
const TOKEN_HASH_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;

interface ConfirmParams {
  tokenHash: string | null;
  type: EmailOtpType | null;
  next: string;
}

function readParams(source: URLSearchParams | FormData): ConfirmParams {
  const text = (key: string) => {
    const value = source.get(key);
    return typeof value === "string" ? value : null;
  };
  const tokenHash = text("token_hash");
  const type = text("type") as EmailOtpType | null;
  return {
    tokenHash: tokenHash && TOKEN_HASH_PATTERN.test(tokenHash) ? tokenHash : null,
    type: type && ALLOWED_TYPES.includes(type) ? type : null,
    next: safeReturnPath(text("next")),
  };
}

function signInAgain(origin: string, next: string): NextResponse {
  const signIn = new URL("/sign-in", origin);
  signIn.searchParams.set("error", "link");
  if (next !== "/") signIn.searchParams.set("next", next);
  return NextResponse.redirect(signIn, 303);
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** The "Continue signing in" page. No scripts; the button posts the token back here. */
function continuePage({ tokenHash, type, next }: { tokenHash: string; type: EmailOtpType; next: string }): string {
  const hidden = (name: string, value: string) => `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Sign in to GladRags</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; padding: 48px 16px; color: #171717; background: #fff; }
  main { max-width: 360px; margin: 0 auto; text-align: center; }
  h1 { font-size: 1.5rem; margin: 0 0 8px; }
  p { margin: 0 0 24px; color: #525252; }
  button { width: 100%; padding: 12px 16px; font: inherit; font-weight: 600; color: #fff; background: #171717; border: 0; border-radius: 8px; }
  @media (prefers-color-scheme: dark) { body { color: #fafafa; background: #0a0a0a; } p { color: #a3a3a3; } button { color: #171717; background: #fafafa; } }
</style>
</head>
<body>
<main>
<h1>GladRags</h1>
<p>Tap the button to finish signing in.</p>
<form method="post" action="/auth/confirm">
${hidden("token_hash", tokenHash)}
${hidden("type", type)}
${hidden("next", next)}
<button type="submit">Continue signing in</button>
</form>
</main>
</body>
</html>`;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const params = readParams(url.searchParams);
  if (!params.tokenHash || !params.type) return signInAgain(url.origin, params.next);
  return new NextResponse(continuePage({ tokenHash: params.tokenHash, type: params.type, next: params.next }), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      // The token is in this page: keep it out of every cache.
      "cache-control": "no-store",
    },
  });
}

export async function POST(request: Request) {
  const url = new URL(request.url);
  if (isCrossSiteRequest(request)) {
    return new NextResponse("That sign-in request came from another site, so it was refused.", {
      status: 403,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return signInAgain(url.origin, "/");
  }
  const { tokenHash, type, next } = readParams(form);
  if (tokenHash && type && isMockMode()) return NextResponse.redirect(new URL(next, url.origin), 303);
  if (tokenHash && type) {
    const supabase = await createClient();
    const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
    if (!error) return NextResponse.redirect(new URL(next, url.origin), 303);
    console.error("verifyOtp(token_hash) failed", error.message);
  }
  return signInAgain(url.origin, next);
}
