import { NextResponse } from "next/server";
import { z } from "zod";
import { API_ERROR_STATUS, type ApiError } from "@/contracts";
import { ConfigError } from "@/lib/env";
import { CapReachedError } from "@/lib/usage/errors";
import { ApiException } from "./errors";

/**
 * Small helpers that keep every route handler the same shape:
 *
 *   export const POST = withApiHandler(async (request) => {
 *     const body = await parseJsonBody(request, SomeRequestSchema);
 *     ...
 *     return jsonResponse(SomeResponseSchema, data);
 *   });
 *
 * Cross-site request forgery (CSRF) protection, on top of SameSite=Lax
 * session cookies:
 * - withApiHandler refuses an unsafe method (POST, PATCH, PUT, DELETE)
 *   from another site (403 forbidden). A browser's `Sec-Fetch-Site:
 *   same-origin` is trusted (pages can't set it). Otherwise the Origin
 *   must be this site's; with no Origin, a Sec-Fetch-Site of "cross-site"
 *   is refused too.
 * - parseJsonBody requires Content-Type: application/json (415
 *   unsupported_media_type). A plain HTML form can't send that type, so a
 *   JSON route can't be driven by a form on another site.
 */

function issuesFrom(error: z.ZodError) {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    message: issue.message,
  }));
}

function badRequest(error: z.ZodError, what: string): ApiException {
  return new ApiException("bad_request", `The ${what} isn't valid`, { issues: issuesFrom(error) });
}

/** True if the Content-Type is JSON (application/json, optionally with parameters such as charset). */
export function isJsonContentType(contentType: string | null): boolean {
  return contentType !== null && /^\s*application\/json\s*(;|$)/i.test(contentType);
}

/**
 * Parse and validate a JSON request body. Throws unsupported_media_type
 * unless the Content-Type is application/json, and bad_request if the
 * body isn't valid JSON or fails the schema.
 */
export async function parseJsonBody<T extends z.ZodType>(request: Request, schema: T): Promise<z.infer<T>> {
  if (!isJsonContentType(request.headers.get("content-type"))) {
    throw new ApiException("unsupported_media_type", "The request must be sent as JSON (Content-Type: application/json)");
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ApiException("bad_request", "The request body must be JSON");
  }
  const result = schema.safeParse(body);
  if (!result.success) throw badRequest(result.error, "request");
  return result.data;
}

/** Validate a query string. Repeated keys keep the last value. */
export function parseSearchParams<T extends z.ZodType>(request: Request, schema: T): z.infer<T> {
  const params = Object.fromEntries(new URL(request.url).searchParams.entries());
  const result = schema.safeParse(params);
  if (!result.success) throw badRequest(result.error, "query");
  return result.data;
}

/** Validate dynamic route params such as { id }. */
export async function parseRouteParams<T extends z.ZodType>(params: Promise<unknown>, schema: T): Promise<z.infer<T>> {
  const result = schema.safeParse(await params);
  if (!result.success) {
    // A malformed ID can't match any row; treat it like a missing one.
    throw new ApiException("not_found", "That wasn't found");
  }
  return result.data;
}

/**
 * Send a JSON response, checking it against its contract first. A mismatch
 * is a server bug, so it becomes a 500 rather than reaching the client.
 */
export function jsonResponse<T extends z.ZodType>(schema: T, data: z.input<T>, init?: ResponseInit): NextResponse {
  const result = schema.safeParse(data);
  if (!result.success) {
    console.error("Response failed its contract", z.prettifyError(result.error));
    return errorResponse(new ApiException("internal", "Something went wrong on our side"));
  }
  return NextResponse.json(result.data, init);
}

export function errorResponse(error: ApiException): NextResponse {
  const body: ApiError = { error: { code: error.code, message: error.message, ...error.extras } };
  return NextResponse.json(body, { status: API_ERROR_STATUS[error.code] });
}

function toApiException(error: unknown): ApiException {
  if (error instanceof ApiException) return error;
  if (error instanceof CapReachedError) return error.toApiException();
  if (error instanceof ConfigError) {
    console.error(error.message);
    return new ApiException("server_misconfigured", "GladRags isn't set up correctly on the server yet");
  }
  console.error("Unhandled API error", describeError(error));
  return new ApiException("internal", "Something went wrong on our side");
}

/**
 * What's safe to log about an unexpected error: its name, code and message.
 * Never the whole object, which can carry request data, headers or keys
 * (Supabase and fetch errors do).
 */
export function describeError(error: unknown): { name: string; code?: string; message: string } {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return { name: error.name, ...(typeof code === "string" ? { code } : {}), message: error.message };
  }
  return { name: typeof error, message: "Non-Error value thrown" };
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** The origins this site answers to: the request's own, and NEXT_PUBLIC_SITE_URL's if set. */
function allowedOrigins(request: Request): Set<string> {
  const origins = new Set([new URL(request.url).origin]);
  const site = process.env.NEXT_PUBLIC_SITE_URL;
  if (site) {
    try {
      origins.add(new URL(site).origin);
    } catch {
      // A malformed NEXT_PUBLIC_SITE_URL adds nothing.
    }
  }
  return origins;
}

/**
 * Whether a request could have come from another site. Safe methods
 * (GET, HEAD, OPTIONS) always pass: they must not change anything.
 *
 * `Sec-Fetch-Site: same-origin` passes: browsers set it and pages can't
 * forge it. That covers an Origin of "null" (sent on a same-origin form
 * POST from a page with `Referrer-Policy: no-referrer`) and a host that
 * differs from request.url (testing over the LAN from a phone, or behind a
 * proxy). Otherwise a present Origin must be this site's (a "null" origin
 * never is: `same-site` from a sibling subdomain is still refused), and
 * with no Origin, Sec-Fetch-Site mustn't be "cross-site". Requests with
 * neither header (curl, server-to-server) pass: they carry no browser
 * cookies unless the caller has them anyway.
 */
export function isCrossSiteRequest(request: Request): boolean {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return false;
  if (request.headers.get("sec-fetch-site") === "same-origin") return false;
  const origin = request.headers.get("origin");
  if (origin !== null) return !allowedOrigins(request).has(origin);
  return request.headers.get("sec-fetch-site") === "cross-site";
}

/**
 * Wrap a route handler so thrown errors become typed JSON error responses,
 * and cross-site requests with unsafe methods are refused (403 forbidden)
 * before the handler runs.
 */
export function withApiHandler<Args extends unknown[]>(
  handler: (request: Request, ...rest: Args) => Promise<Response>,
): (request: Request, ...rest: Args) => Promise<Response> {
  return async (request, ...rest) => {
    try {
      if (isCrossSiteRequest(request)) {
        throw new ApiException("forbidden", "That request came from another site, so it was refused");
      }
      return await handler(request, ...rest);
    } catch (error) {
      return errorResponse(toApiException(error));
    }
  };
}
