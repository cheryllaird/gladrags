/**
 * Provider interfaces for the AI model (spec: Gemini Flash, behind an
 * interface so it can be swapped). Implementations live next to this file
 * and are owned by ingestion (tagging) and outfit-engine (ranking).
 *
 * Providers return the model's raw output. They never validate it: callers
 * use callWithValidation() with a schema from src/contracts/model-output.ts.
 */
import type { ItemTags, OutfitRequest, RefineRequest } from "@/contracts";

export type ImageMimeType = "image/jpeg" | "image/png" | "image/webp";

export interface ImageInput {
  data: Uint8Array;
  mimeType: ImageMimeType;
}

/** One model call: its unvalidated output and what it cost. */
export interface ModelCall {
  /** Raw output: a JSON string, or a value the SDK already parsed. */
  raw: unknown;
  /** Cost in pence if the provider can work it out; otherwise the estimate is used. */
  costPence?: number;
  /** For usage_events.provider, e.g. "gemini". */
  provider: string;
  /** Model name, for logs. */
  model: string;
}

// ---------------------------------------------------------------------------
// Tagging
// ---------------------------------------------------------------------------

export interface TaggingInput {
  /** The cut-out (or original if background removal failed). */
  image: ImageInput;
  /** What a product page said, when the item came from a link. */
  productHints?: {
    title?: string | null;
    brand?: string | null;
    colour?: string | null;
  };
}

export interface TaggingProvider {
  readonly name: string;
  /** Output should validate against TaggingModelOutputSchema. */
  tagItem(input: TaggingInput): Promise<ModelCall>;
}

// ---------------------------------------------------------------------------
// Ranking (two passes)
// ---------------------------------------------------------------------------

/** An item as the ranking model sees it in pass 1: ID and tags, no image. */
export interface RankingItem {
  id: string;
  tags: ItemTags;
}

export interface RankingContext {
  request: Pick<OutfitRequest, "style" | "anchorItemId" | "guidance">;
  /** Pairs of item IDs the user rejected together before ("avoid" hints). */
  avoidPairs: [string, string][];
  /** Set when refining: the outfit being refined and what the user asked for. */
  refinement?: { previousItemIds: string[]; feedback: RefineRequest };
}

export interface ShortlistInput extends RankingContext {
  /** The filtered wardrobe. */
  items: RankingItem[];
  /** Valid combinations generated in code, by item ID. */
  candidates: string[][];
  /** How many to shortlist ("about 8"). */
  shortlistSize: number;
}

export interface FinalPickInput extends RankingContext {
  /** Shortlisted outfits with a small (~256 px) thumbnail of each item's cut-out. */
  shortlist: { itemIds: string[]; thumbnails: { itemId: string; image: ImageInput }[] }[];
  /** How many outfits to return (3–5). */
  count: number;
}

export interface RankingProvider {
  readonly name: string;
  /** Pass 1, tags only. Output should validate against RankingShortlistOutputSchema. */
  shortlist(input: ShortlistInput): Promise<ModelCall>;
  /** Pass 2, with thumbnails. Output should validate against RankingFinalOutputSchema. */
  pickFinal(input: FinalPickInput): Promise<ModelCall>;
}
