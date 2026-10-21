import type { z } from "zod";
import { parseModelOutput } from "@/contracts";
import type { ModelCall } from "./types";

export type ValidatedCallResult<T> =
  | { ok: true; data: T; attempts: number }
  | { ok: false; errors: string[]; attempts: number };

export interface CallWithValidationOptions {
  /** Called after every attempt, valid or not, so its cost can be recorded. */
  onCall?: (call: ModelCall) => void | Promise<void>;
  /** Total attempts. The spec says validate, retry once: 2. */
  maxAttempts?: number;
}

/**
 * Run a model call and validate its output; on failure, retry once. The
 * caller then applies the spec's fallback when `ok` is false (tagging:
 * show empty tags; ranking: return an ai_failed error).
 *
 * A provider that throws (network error, quota) also counts as a failed
 * attempt.
 */
export async function callWithValidation<T>(
  schema: z.ZodType<T>,
  call: () => Promise<ModelCall>,
  { onCall, maxAttempts = 2 }: CallWithValidationOptions = {},
): Promise<ValidatedCallResult<T>> {
  const errors: string[] = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let result: ModelCall;
    try {
      result = await call();
    } catch (error) {
      errors.push(`Provider error: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    await onCall?.(result);
    const parsed = parseModelOutput(schema, result.raw);
    if (parsed.success) return { ok: true, data: parsed.data, attempts: attempt };
    errors.push(parsed.error);
  }
  return { ok: false, errors, attempts: maxAttempts };
}
