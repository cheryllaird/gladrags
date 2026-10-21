// Magic-link landing for a customised email template that links to
// /auth/confirm?token_hash={{ .TokenHash }}&type=email&next=/path.
// Unlike /auth/callback this works in any browser, not only the one that
// asked for the link. See docs/CONTRACTS.md, "Auth".
import type { EmailOtpType } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { safeReturnPath } from "@/lib/auth/redirect";
import { createClient } from "@/lib/supabase/server";

const ALLOWED_TYPES: readonly EmailOtpType[] = ["email", "magiclink", "signup"];

export async function GET(request: Request) {
  const url = new URL(request.url);
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type") as EmailOtpType | null;
  const next = safeReturnPath(url.searchParams.get("next"));

  if (tokenHash && type && ALLOWED_TYPES.includes(type)) {
    const supabase = await createClient();
    const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
    if (!error) return NextResponse.redirect(new URL(next, url.origin));
    console.error("verifyOtp(token_hash) failed", error.message);
  }

  const signIn = new URL("/sign-in", url.origin);
  signIn.searchParams.set("error", "link");
  return NextResponse.redirect(signIn);
}
