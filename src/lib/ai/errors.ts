/**
 * Errors providers throw that callers treat differently from an ordinary
 * failed call.
 */

/**
 * The provider refused the request before doing any work because the
 * account's quota or rate limit is used up (Gemini: HTTP 429
 * RESOURCE_EXHAUSTED; the free tier has no image quota at all). Nothing was
 * billed, so callers book 0p and don't retry.
 */
export class ProviderQuotaError extends Error {
  constructor(message = "The AI provider's quota is used up") {
    super(message);
    this.name = "ProviderQuotaError";
  }
}

/** True for a Gemini SDK error that is a quota or rate-limit refusal (HTTP 429 / RESOURCE_EXHAUSTED). */
export function isGeminiQuotaRefusal(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const status = (error as { status?: unknown }).status;
  return status === 429 || /RESOURCE_EXHAUSTED/.test(error.message);
}
