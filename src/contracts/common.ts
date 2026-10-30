import { z } from "zod";

// Never compile parsers with `new Function`: Zod otherwise probes for eval
// support on first use, which the Content Security Policy (next.config.ts)
// reports, and would block once it's enforced. Our schemas are small, so
// the interpreted parsers are plenty fast. Set here because every contract
// module imports this one first.
z.config({ jitless: true });

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

/** For optional text: "", whitespace-only and missing all become null. */
export function emptyToNull(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  return value;
}

/**
 * Removes half of a surrogate pair, e.g. an emoji cut in two by a length
 * limit. Postgres jsonb rejects lone surrogates, so they must never be stored.
 */
function dropLoneSurrogates(text: string): string {
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}

/**
 * Text scraped from a web page or an email (or returned by a model reading
 * one), on its way into a prompt or the database: whitespace (including
 * newlines) collapsed to single spaces, cut to `max` characters, and ""
 * read as null. After that it must be a single line, like every other
 * prompt-bound text.
 */
export function scrapedText(max: number) {
  return z.preprocess((value) => {
    if (typeof value !== "string") return emptyToNull(value);
    const flat = dropLoneSurrogates(value.replace(/\s+/g, " ").trim().slice(0, max)).trim();
    return flat === "" ? null : flat;
  }, singleLineText(max).nullable());
}

/**
 * Error codes every API route can return. The HTTP status for each is fixed
 * (see API_ERROR_STATUS) so the UI can branch on `code` alone.
 */
export const API_ERROR_CODES = [
  "bad_request", // input failed validation
  "unauthorized", // not signed in
  "not_invited", // email isn't on the tester allowlist
  "forbidden", // a cross-site request (its Origin isn't this site)
  "not_found", // row doesn't exist or isn't yours
  "unsupported_media_type", // a JSON route was sent something other than JSON
  "daily_cap_reached", // per-user daily cap on items, outfit requests, link fetches, forwarded emails or shop searches
  "rate_limited", // too many sign-in attempts; try again later
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
  forbidden: 403,
  not_found: 404,
  unsupported_media_type: 415,
  daily_cap_reached: 429,
  rate_limited: 429,
  ai_paused: 503,
  ai_failed: 502,
  server_misconfigured: 500,
  not_implemented: 501,
  internal: 500,
};

/** Which cap an error refers to (`cap.kind`). */
export const CAP_KINDS = [
  "items_per_day",
  "outfit_requests_per_day",
  "link_fetches_per_day",
  "emails_per_day",
  "shop_searches_per_day",
  "monthly_ai_spend",
] as const;
export const CapKindSchema = z.enum(CAP_KINDS);
export type CapKind = z.infer<typeof CapKindSchema>;

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
        kind: CapKindSchema,
        limit: z.number(),
        resetsAt: TimestampSchema,
      })
      .optional(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;
