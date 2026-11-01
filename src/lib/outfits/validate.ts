/**
 * Pipeline step 4: check every outfit the model returns. Pure.
 *
 * The model only chooses and explains; this decides what's valid. Each
 * outfit in a reply is judged on its own, so one bad outfit never costs the
 * good ones next to it. An outfit is thrown out when it:
 * - fails the contract's per-outfit schema (not UUIDs, an item twice, a
 *   name over 40 or a reason over 160 characters, …);
 * - uses an item ID the model wasn't given (so never one outside the
 *   user's wardrobe), breaks the composition rule (owned items and gaps
 *   together), leaves out the anchor, or has a gap the request doesn't
 *   allow (all via the shared checkRankedOutfits and its GapRules);
 * - leaves out another required item (the items kept in a swap);
 * - isn't one of the outfits offered (pass 1: the code-generated
 *   candidates; pass 2: the shortlist), owned items and gap slots both, so
 *   the formality-spread and avoid-hint guarantees of candidate generation
 *   always hold;
 * - repeats an outfit that's excluded (rejected before, or being refined),
 *   or an earlier outfit in the same reply;
 * - shows the model's internal item refs ("I3") in its name, reason or a
 *   gap's description.
 */
import { z } from "zod";
import { checkRankedOutfits, type Category, type GapRules } from "@/contracts";
import { shapeKey, type OutfitShape } from "./candidates";

export interface OutfitRules {
  /** Every item ID the model was allowed to use, with its category. */
  known: ReadonlyMap<string, Category>;
  anchorItemId?: string | null;
  /** Other items every outfit must include. */
  requiredIds?: readonly string[];
  /** Exact combinations (owned items and gap slots) that mustn't come back. */
  excludeOutfits?: readonly OutfitShape[];
  /** When set, only these exact combinations (in any order, gap slots included) are allowed. */
  allowedOutfits?: readonly OutfitShape[];
  /** How gaps are judged. Left out: any gap is refused. */
  gaps?: GapRules;
}

/** What validation needs from one outfit in a reply. */
export interface CheckableOutfit {
  itemIds: string[];
  gaps?: readonly { category: Category; description?: string }[];
  name?: string;
  reason?: string;
}

export interface OutfitCheck<T> {
  valid: T[];
  rejected: { outfit: T; problem: string }[];
}

/** An item ref like "I3", as the Gemini prompts call items. */
const ITEM_REF = /\bI\d+\b/;

export function validateOutfits<T extends CheckableOutfit>(outfits: readonly T[], rules: OutfitRules): OutfitCheck<T> {
  const shared = checkRankedOutfits(outfits, rules.known, { anchorItemId: rules.anchorItemId ?? undefined, gaps: rules.gaps });
  const result: OutfitCheck<T> = { valid: [], rejected: [...shared.rejected] };
  const excluded = new Set((rules.excludeOutfits ?? []).map(shapeKey));
  const allowed = rules.allowedOutfits ? new Set(rules.allowedOutfits.map(shapeKey)) : null;
  const seen = new Set<string>();

  for (const outfit of shared.valid) {
    const missing = (rules.requiredIds ?? []).filter((id) => !outfit.itemIds.includes(id));
    const key = shapeKey({ itemIds: outfit.itemIds, gaps: (outfit.gaps ?? []).map((g) => g.category) });
    const texts = [outfit.name ?? "", outfit.reason ?? "", ...(outfit.gaps ?? []).map((g) => g.description ?? "")];
    let problem: string | null = null;
    if (missing.length > 0) problem = `Doesn't include required item(s): ${missing.join(", ")}`;
    else if (allowed && !allowed.has(key)) problem = "Isn't one of the outfits offered";
    else if (excluded.has(key)) problem = "Repeats an outfit that was rejected or is being refined";
    else if (seen.has(key)) problem = "Repeats an earlier outfit in the same reply";
    else if (texts.some((text) => ITEM_REF.test(text))) {
      problem = "Mentions an item ref in its name, reason or a gap's description";
    }

    if (problem) {
      result.rejected.push({ outfit, problem });
    } else {
      seen.add(key);
      result.valid.push(outfit);
    }
  }
  return result;
}

/**
 * A ranking reply's envelope: just `{ outfits: [...] }` with at least one
 * entry. Each entry is then checked on its own with the contract's
 * per-outfit schema (parseEachOutfit), so a schema problem in one outfit
 * doesn't throw away the others.
 */
export const RankingReplyEnvelopeSchema = z.object({ outfits: z.array(z.unknown()).min(1) });

export interface ParsedOutfits<T> {
  parsed: T[];
  problems: string[];
}

/** Parse each outfit with `schema` (the contract's per-outfit schema), keeping the ones that pass. */
export function parseEachOutfit<T>(outfits: readonly unknown[], schema: z.ZodType<T>): ParsedOutfits<T> {
  const result: ParsedOutfits<T> = { parsed: [], problems: [] };
  outfits.forEach((outfit, index) => {
    const parsed = schema.safeParse(outfit);
    if (parsed.success) result.parsed.push(parsed.data);
    else result.problems.push(`Outfit ${index + 1}: ${z.prettifyError(parsed.error).replace(/\s+/g, " ")}`);
  });
  return result;
}

export interface ReplyCheck<T> {
  valid: T[];
  /** Null when the reply is good enough; otherwise why it should be retried. */
  problem: string | null;
}

/**
 * Judge one reply: parse each outfit, apply the rules, and decide whether
 * it's good enough. A reply with at least `enough` valid outfits is
 * accepted even if others were bad (they're dropped), so a usable reply is
 * never retried.
 */
export function checkReply<T extends CheckableOutfit>(
  outfits: readonly unknown[],
  schema: z.ZodType<T>,
  rules: OutfitRules,
  enough: number,
): ReplyCheck<T> {
  const { parsed, problems } = parseEachOutfit(outfits, schema);
  const check = validateOutfits(parsed, rules);
  const allProblems = [...problems, ...check.rejected.map((r) => r.problem)];
  if (check.valid.length >= enough || allProblems.length === 0) return { valid: check.valid, problem: null };
  return { valid: check.valid, problem: allProblems.join("; ") };
}
