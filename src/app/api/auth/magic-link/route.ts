// Real implementation (foundations): email a sign-in link (and code) to an
// allowlisted address. Returns not_invited (403) for anyone else.
import { MagicLinkRequestSchema, MagicLinkResponseSchema } from "@/contracts";
import { ApiException } from "@/lib/api/errors";
import { jsonResponse, parseJsonBody, withApiHandler } from "@/lib/api/http";
import { isEmailAllowed } from "@/lib/auth/allowlist";
import { getSiteUrl, isMockMode } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";

export const POST = withApiHandler(async (request) => {
  const { email, next } = await parseJsonBody(request, MagicLinkRequestSchema);

  if (!(await isEmailAllowed(email))) {
    throw new ApiException(
      "not_invited",
      "GladRags is invite-only while we test it, and this email isn't on the list.",
    );
  }

  if (!isMockMode()) {
    const callback = new URL("/auth/callback", getSiteUrl(new URL(request.url).origin));
    if (next) callback.searchParams.set("next", next);

    const supabase = await createClient();
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: callback.toString(), shouldCreateUser: true },
    });
    if (error) {
      console.error("signInWithOtp failed", error.status, error.message);
      throw new ApiException("internal", "We couldn't send the email. Wait a minute and try again.");
    }
  }

  return jsonResponse(MagicLinkResponseSchema, { sent: true });
});
