import { z } from "zod";

/** Database row IDs are UUIDs everywhere. */
export const IdSchema = z.uuid();
export type Id = z.infer<typeof IdSchema>;

/** Timestamps cross the API as ISO 8601 strings with a UTC offset. */
export const TimestampSchema = z.iso.datetime({ offset: true });

/**
 * A short, single-line piece of user text (guidance, swap notes, reasons).
 * Trimmed, and newlines are not allowed so it can't smuggle extra prompt
 * sections into model requests.
 */
export function singleLineText(max: number) {
  return z
    .string()
    .trim()
    .min(1, { error: "Can't be empty" })
    .max(max, { error: `Must be ${max} characters or fewer` })
    .regex(/^[^\r\n]*$/, { error: "Must be a single line" });
}

/**
 * Error codes every API route can return. The HTTP status for each is fixed
 * (see API_ERROR_STATUS) so the UI can branch on `code` alone.
 */
export const API_ERROR_CODES = [
  "bad_request", // input failed validation
  "unauthorized", // not signed in
  "not_invited", // email isn't on the tester allowlist
  "not_found", // row doesn't exist or isn't yours
  "daily_cap_reached", // per-user daily cap on items or outfit requests
  "ai_paused", // the monthly AI spend cap has been reached
  "ai_failed", // model output failed validation twice, or the provider errored
  "server_misconfigured", // missing environment variables
  "not_implemented", // route is still a mock-only stub (outside mock mode)
  "internal", // anything else
] as const;
export const ApiErrorCodeSchema = z.enum(API_ERROR_CODES);
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;

export const API_ERROR_STATUS: Record<ApiErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  not_invited: 403,
  not_found: 404,
  daily_cap_reached: 429,
  ai_paused: 503,
  ai_failed: 502,
  server_misconfigured: 500,
  not_implemented: 501,
  internal: 500,
};

export const ApiErrorSchema = z.object({
  error: z.object({
    code: ApiErrorCodeSchema,
    /** Plain-English message safe to show the user. */
    message: z.string(),
    /** Validation problems, for `bad_request`. */
    issues: z
      .array(z.object({ path: z.string(), message: z.string() }))
      .optional(),
    /** Which cap was hit and when it resets, for `daily_cap_reached` and `ai_paused`. */
    cap: z
      .object({
        kind: z.enum(["items_per_day", "outfit_requests_per_day", "monthly_ai_spend"]),
        limit: z.number(),
        resetsAt: TimestampSchema,
      })
      .optional(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;
