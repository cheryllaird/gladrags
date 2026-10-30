/**
 * Provider interfaces for the AI model (spec: Gemini Flash, behind an
 * interface so it can be swapped). Implementations live next to this file
 * and are owned by ingestion (tagging) and outfit-engine (ranking).
 *
 * Providers return the model's raw output. They never validate it: callers
 * use callWithValidation() with a schema from src/contracts/model-output.ts.
 */
import type { GapDescription, ItemTags, OutfitRequest, RefineRequest, ShopId } from "@/contracts";

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
  /** Set (by callWithValidation) when the provider threw instead of returning. */
  error?: string;
}

// ---------------------------------------------------------------------------
// Tagging
// ---------------------------------------------------------------------------

export interface TaggingInput {
  /**
   * The item's image (the original; a cut-out where one exists). Null only
   * for an order-email line with no usable picture: the model then tags from
   * `productHints` alone, which must include a title.
   */
  image: ImageInput | null;
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

// ---------------------------------------------------------------------------
// Order emails and shop search (milestone 5)
// ---------------------------------------------------------------------------

export interface OrderEmailInput {
  /** The email's subject, cleaned (single line). */
  subject: string | null;
  /**
   * The email as text: the plain-text body, or the HTML converted to text
   * with product and image links kept. Never attachments. The prompt must
   * treat it as data, not instructions.
   */
  text: string;
}

/** Reads the clothing and shoe lines out of an order email. Built by link-import. */
export interface OrderEmailProvider {
  readonly name: string;
  /** Output should validate against OrderEmailModelOutputSchema. */
  extractOrder(input: OrderEmailInput): Promise<ModelCall>;
}

export interface ShopSearchInput {
  /** The outfit's gaps to find, one per category. */
  gaps: Pick<GapDescription, "category" | "subcategory" | "colours" | "description">[];
  /** The user's favourite shops, with the website domains to search. */
  shops: { id: ShopId; name: string; domains: readonly string[] }[];
}

/** Gemini with Google Search grounding, for "Find in my shops". Built by outfit-engine. */
export interface ShopSearchProvider {
  readonly name: string;
  /** Output should validate against ShopSearchModelOutputSchema. */
  searchGaps(input: ShopSearchInput): Promise<ModelCall>;
}
