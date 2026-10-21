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

/** Parse and validate a JSON request body. Throws a bad_request ApiException. */
export async function parseJsonBody<T extends z.ZodType>(request: Request, schema: T): Promise<z.infer<T>> {
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

/** Wrap a route handler so thrown errors become typed JSON error responses. */
export function withApiHandler<Args extends unknown[]>(
  handler: (request: Request, ...rest: Args) => Promise<Response>,
): (request: Request, ...rest: Args) => Promise<Response> {
  return async (request, ...rest) => {
    try {
      return await handler(request, ...rest);
    } catch (error) {
      return errorResponse(toApiException(error));
    }
  };
}
