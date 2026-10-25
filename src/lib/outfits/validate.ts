/**
 * Pipeline step 4: check every outfit the model returns. Pure.
 *
 * The model only chooses and explains; this decides what's valid. An
 * outfit is thrown out when it:
 * - uses an item ID the model wasn't given (so never one outside the
 *   user's wardrobe), breaks the composition rule, or leaves out the anchor
 *   (all via the shared checkRankedOutfits);
 * - leaves out another required item (the items kept in a swap);
 * - repeats an outfit that's excluded (rejected before, or being refined);
 * - repeats an earlier outfit in the same reply.
 */
import { checkRankedOutfits, type Category } from "@/contracts";
import { outfitKey } from "./candidates";

export interface OutfitRules {
  /** Every item ID the model was allowed to use, with its category. */
  known: ReadonlyMap<string, Category>;
  anchorItemId?: string | null;
  /** Other items every outfit must include. */
  requiredIds?: readonly string[];
  /** Exact combinations that mustn't come back. */
  excludeOutfits?: readonly (readonly string[])[];
}

export interface OutfitCheck<T> {
  valid: T[];
  rejected: { outfit: T; problem: string }[];
}

export function validateOutfits<T extends { itemIds: string[] }>(outfits: readonly T[], rules: OutfitRules): OutfitCheck<T> {
  const shared = checkRankedOutfits(outfits, rules.known, { anchorItemId: rules.anchorItemId ?? undefined });
  const result: OutfitCheck<T> = { valid: [], rejected: [...shared.rejected] };
  const excluded = new Set((rules.excludeOutfits ?? []).map(outfitKey));
  const seen = new Set<string>();

  for (const outfit of shared.valid) {
    const missing = (rules.requiredIds ?? []).filter((id) => !outfit.itemIds.includes(id));
    const key = outfitKey(outfit.itemIds);
    let problem: string | null = null;
    if (missing.length > 0) problem = `Doesn't include required item(s): ${missing.join(", ")}`;
    else if (excluded.has(key)) problem = "Repeats an outfit that was rejected or is being refined";
    else if (seen.has(key)) problem = "Repeats an earlier outfit in the same reply";

    if (problem) {
      result.rejected.push({ outfit, problem });
    } else {
      seen.add(key);
      result.valid.push(outfit);
    }
  }
  return result;
}

/** One line describing every problem, for callWithValidation's `check`. Null when all are valid. */
export function describeProblems(check: OutfitCheck<unknown>): string | null {
  if (check.rejected.length === 0) return null;
  return check.rejected.map((r) => r.problem).join("; ");
}
