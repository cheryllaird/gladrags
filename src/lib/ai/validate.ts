import type { z } from "zod";
import { parseModelOutput } from "@/contracts";
import type { ModelCall } from "./types";

export type ValidatedCallResult<T> =
  | { ok: true; data: T; attempts: number }
  | { ok: false; errors: string[]; attempts: number };

export interface CallWithValidationOptions<T> {
  /**
   * Called before every attempt, e.g. to reserve the call's estimated cost
   * against the monthly AI cap. If it throws (the cap is reached), no call
   * is made and the error is passed on: it isn't a failed attempt.
   *
   *   ...usage.meterAiCalls(user.id, "tagging")  // sets beforeCall and onCall
   */
  beforeCall?: () => void | Promise<void>;
  /**
   * Called after every attempt so its cost can be recorded, including
   * attempts where the provider threw (a timed-out call may still be
   * billed). For a thrown attempt, `raw` and `costPence` are undefined, so
   * the reserved estimate stands (see UsageGuard.meterAiCalls).
   */
  onCall?: (call: ModelCall) => void | Promise<void>;
  /**
   * Checks the model can only fail with context, after the schema passes:
   * e.g. unknown item IDs, broken composition, a missing anchor (use
   * checkRankedOutfits). Return a problem description to treat the attempt
   * as failed, or null if it's fine. Schema and semantic failures share
   * the same single retry.
   */
  check?: (data: T) => string | null;
  /** Provider name to record for attempts that threw. */
  provider?: string;
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
  { beforeCall, onCall, check, provider = "unknown", maxAttempts = 2 }: CallWithValidationOptions<T> = {},
): Promise<ValidatedCallResult<T>> {
  const errors: string[] = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await beforeCall?.();
    let result: ModelCall;
    try {
      result = await call();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`Provider error: ${message}`);
      await onCall?.({ raw: undefined, costPence: undefined, provider, model: "unknown", error: message });
      continue;
    }
    await onCall?.(result);
    const parsed = parseModelOutput(schema, result.raw);
    if (!parsed.success) {
      errors.push(parsed.error);
      continue;
    }
    const problem = check?.(parsed.data) ?? null;
    if (problem) {
      errors.push(problem);
      continue;
    }
    return { ok: true, data: parsed.data, attempts: attempt };
  }
  return { ok: false, errors, attempts: maxAttempts };
}
