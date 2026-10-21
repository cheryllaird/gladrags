// Real implementation (foundations). Returns JSON for fetch() callers, and
// redirects to /sign-in when posted from a plain HTML form.
import { NextResponse } from "next/server";
import { SignOutResponseSchema } from "@/contracts";
import { jsonResponse, withApiHandler } from "@/lib/api/http";
import { isMockMode } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";

export const POST = withApiHandler(async (request) => {
  if (!isMockMode()) {
    const supabase = await createClient();
    await supabase.auth.signOut();
  }
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.startsWith("application/x-www-form-urlencoded") || contentType.startsWith("multipart/form-data")) {
    return NextResponse.redirect(new URL("/sign-in", request.url), 303);
  }
  return jsonResponse(SignOutResponseSchema, { signedOut: true });
});
