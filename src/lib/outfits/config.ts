/**
 * Tuning numbers for the outfit engine. Each one keeps a request bounded in
 * cost and time, whatever the size of the wardrobe. See README.md in this
 * folder for how they fit together.
 */
import { OUTFIT_COUNT, SHORTLIST_MAX } from "@/contracts";

/** How many outfits ranking pass 1 asks for (spec: "about 8"). */
export const SHORTLIST_SIZE = 8;

/**
 * Most candidate outfits sent to ranking pass 1. Candidates are generated
 * in code; above this many, a seeded random sample is sent. 60 candidates
 * of up to 4 short item references is well under 1,000 prompt tokens.
 */
export const MAX_CANDIDATES_SENT = 60;

/**
 * Up to this many combinations, every combination is listed and then
 * sampled. Above it (a big wardrobe: 200 items can make millions), random
 * combinations are drawn directly, so generation never enumerates them all.
 */
export const ENUMERATE_LIMIT = 5_000;

/** Draws allowed per wanted candidate when sampling a big wardrobe. */
export const SAMPLE_ATTEMPTS_PER_CANDIDATE = 40;

/**
 * Most formality points between the least and most formal item in one
 * candidate (e.g. a 1 t-shirt with a 3 coat is fine, with 4 heels isn't).
 * A style heuristic for picking candidates, not a validity rule: the model's
 * picks are only checked against the composition rule.
 */
export const MAX_FORMALITY_SPREAD = 2;

/** How many outfits a refinement returns (refine requests don't carry a count). */
export const REFINE_COUNT = OUTFIT_COUNT.min;

/** "Avoid" hints: pairs from at most this many recent rejected outfits... */
export const MAX_REJECTED_OUTFITS_FOR_HINTS = 30;
/** ...and at most this many pairs in one prompt. */
export const MAX_AVOID_PAIRS = 60;

/**
 * When the wardrobe allows outfits with gaps, at least this share of the
 * candidates sent to ranking are gap outfits (if there are that many), so
 * complete outfits can't crowd them out entirely. Complete outfits still
 * come first and the prompt prefers them.
 */
export const GAP_CANDIDATE_SHARE = 0.25;

/** Thumbnails for pass 2 are downloaded this many at a time. */
export const THUMBNAIL_CONCURRENCY = 6;

// Pass 1's output schema allows at most SHORTLIST_MAX outfits.
if (SHORTLIST_SIZE > SHORTLIST_MAX) throw new Error("SHORTLIST_SIZE is larger than the shortlist schema allows");

/** "Find in my shops": candidate pages checked per gap (the model may give up to 8). */
export const SHOP_PAGE_CHECKS_PER_GAP = 5;

/** "Find in my shops": product pages fetched at a time. */
export const SHOP_PAGE_CONCURRENCY = 6;

/**
 * "Find in my shops": time for all the page checks together. With the
 * grounded search's two attempts (GEMINI_SHOP_SEARCH_TIMEOUT_MS each) this
 * keeps the route inside its 60 s maxDuration.
 */
export const SHOP_PAGE_BUDGET_MS = 12_000;
