// Real implementation (foundations): sign in with the code from the email.
// This is what makes sign-in work inside the installed PWA on iPhone.
// Rate limited per email and IP, so a 6-digit code can't be guessed.
import { VerifyCodeRequestSchema, VerifyCodeResponseSchema } from "@/contracts";
import { ApiException } from "@/lib/api/errors";
import { jsonResponse, parseJsonBody, withApiHandler } from "@/lib/api/http";
import { assertSignInAttemptAllowed, getSignInAttemptStore } from "@/lib/auth/rate-limit";
import { isMockMode } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";

export const POST = withApiHandler(async (request) => {
  const { email, code, next } = await parseJsonBody(request, VerifyCodeRequestSchema);
  await assertSignInAttemptAllowed(getSignInAttemptStore(), "verify_code", email, request);

  if (!isMockMode()) {
    const supabase = await createClient();
    const { error } = await supabase.auth.verifyOtp({ email, token: code, type: "email" });
    if (error) {
      throw new ApiException("unauthorized", "That code didn't work. It may have expired: ask for a new one.");
    }
  }

  return jsonResponse(VerifyCodeResponseSchema, { signedIn: true, next: next ?? "/" });
});
