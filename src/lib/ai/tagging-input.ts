/**
 * Provider-neutral rules for a tagging request (any TaggingProvider).
 */
import type { TaggingInput } from "./types";

/**
 * True if a request without a picture has what the model needs: a product
 * title (CONTRACTS.md section 11, decision 13). Callers skip the model
 * call otherwise, and the user fills the tags in.
 */
export function canTagFromText(hints: TaggingInput["productHints"]): boolean {
  return Boolean(hints?.title?.trim());
}
