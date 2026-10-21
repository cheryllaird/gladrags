// Where the magic link lands with Supabase's default email template:
// /auth/callback?code=...&next=/path. Exchanges the code for a session.
// The code only works in the browser that asked for the link (PKCE); see
// /auth/confirm and the code-entry route for other cases.
import { NextResponse } from "next/server";
import { safeReturnPath } from "@/lib/auth/redirect";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const next = safeReturnPath(url.searchParams.get("next"));

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL(next, url.origin));
    console.error("exchangeCodeForSession failed", error.message);
  }

  const signIn = new URL("/sign-in", url.origin);
  signIn.searchParams.set("error", "link");
  if (next !== "/") signIn.searchParams.set("next", next);
  return NextResponse.redirect(signIn);
}
