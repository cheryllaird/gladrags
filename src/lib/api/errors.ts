import type { ApiError, ApiErrorCode } from "@/contracts";

type ErrorExtras = Omit<ApiError["error"], "code" | "message">;

/**
 * Throw this from route code to return a typed API error. withApiHandler
 * turns it into a JSON response with the right HTTP status.
 */
export class ApiException extends Error {
  readonly code: ApiErrorCode;
  readonly extras: ErrorExtras;

  constructor(code: ApiErrorCode, message: string, extras: ErrorExtras = {}) {
    super(message);
    this.name = "ApiException";
    this.code = code;
    this.extras = extras;
  }
}

export const notFound = (what = "That") => new ApiException("not_found", `${what} wasn't found`);
export const unauthorized = () => new ApiException("unauthorized", "Please sign in");
