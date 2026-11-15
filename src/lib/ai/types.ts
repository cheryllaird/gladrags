/**
 * Provider interfaces for the AI model (spec: Gemini Flash, behind an
 * interface so it can be swapped). Implementations live next to this file
 * and are owned by ingestion (tagging) and outfit-engine (ranking).
 *
 * Providers return the model's raw output. They never validate it: callers
 * use callWithValidation() with a schema from src/contracts/model-output.ts.
 */
import type { Category, GapDescription, ItemTags, OutfitRequest, RefineRequest, ShopId } from "@/contracts";

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
  /** `includeShopItems` is true when the user asked for items from their shops; missing means false. */
  request: Pick<OutfitRequest, "style" | "anchorItemId" | "guidance" | "includeShopItems">;
  /** Pairs of item IDs the user rejected together before ("avoid" hints). */
  avoidPairs: [string, string][];
  /**
   * Set when refining: the outfit being refined (its owned items and any
   * gaps) and what the user asked for.
   */
  refinement?: { previousItemIds: string[]; previousGaps?: GapDescription[]; feedback: RefineRequest };
}

/**
 * A valid combination generated in code: owned items, plus the slots left
 * as gaps (by category) that the model describes. `gaps` is empty for a
 * complete outfit from the wardrobe.
 */
export interface RankingCandidate {
  itemIds: string[];
  gaps: Category[];
}

export interface ShortlistInput extends RankingContext {
  /** The filtered wardrobe. */
  items: RankingItem[];
  /** Valid combinations generated in code. */
  candidates: RankingCandidate[];
  /** How many to shortlist ("about 8"). */
  shortlistSize: number;
}

/** A gap slot in a shortlisted outfit, with pass 1's description when pass 1 ran. */
export interface ShortlistGap {
  category: Category;
  suggestion?: GapDescription;
}

export interface FinalPickInput extends RankingContext {
  /**
   * The tags of every shortlisted item. Pass 2 sends them along with the
   * photos, so an item without a photo (it still needs one, or its
   * thumbnail failed) is judged by its tags, and pass 2 knows each item even
   * when pass 1 was skipped.
   */
  items: RankingItem[];
  /**
   * Shortlisted outfits with a small (~256 px) thumbnail of each item that
   * has a picture (its cut-out, or the original when there's no cut-out),
   * and the outfit's gap slots.
   */
  shortlist: { itemIds: string[]; gaps: ShortlistGap[]; thumbnails: { itemId: string; image: ImageInput }[] }[];
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
   * with product and image links kept, cut to EMAIL_PROMPT_TEXT_MAX
   * characters. Never attachments. The prompt must
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

// ---------------------------------------------------------------------------
// Outfit previews (round 2)
// ---------------------------------------------------------------------------

/** An owned piece of the outfit, as the image model sees it. */
export interface PreviewItemInput {
  category: Category;
  /**
   * The item's cut-out where one exists, otherwise its original. Null for
   * an item still waiting for a photo: it's described in words only.
   */
  image: ImageInput | null;
  /** A short description, e.g. the item's tag description ("Navy slim-fit chinos"). */
  description: string;
}

/**
 * A gap: the model draws this suggested piece on the figure, so an outfit
 * with gaps still shows as a complete look. With a picked shop product,
 * `productImage` is that product's picture (fetched through link-import's
 * safeFetch with allowRedirect = shopImageUrlAllowed: the shop's domains or its
 * imageHosts, then the image checks).
 * It is model input only: never stored or shown.
 */
export interface PreviewGapInput {
  category: Category;
  subcategory: string | null;
  colours: readonly string[];
  description: string;
  productImage: ImageInput | null;
}

export interface ImageGenerationInput {
  /** The preset figure: its picture and its label ("Women's, average build, medium skin tone"). */
  preset: { id: string; label: string; image: ImageInput };
  items: PreviewItemInput[];
  gaps: PreviewGapInput[];
  /** PREVIEW_ASPECT_RATIO (2:3). The prompt asks for full length, plain background, no text. */
  aspectRatio: { width: number; height: number };
}

/**
 * One image-model call, unchecked. The caller sniffs the real type from
 * the bytes, decodes it, runs checkGeneratedPreviewImage, retries once,
 * then falls back to the collage.
 */
export interface ImageGenerationCall {
  /** The image, or null when the model returned none. */
  image: { data: Uint8Array; mimeType: string } | null;
  /** Set when the model refused (a safety block); `image` is then null. */
  blockReason?: string;
  /** Cost in pence if known; otherwise the image_generation estimate stands. */
  costPence?: number;
  /** Counts as the provider reports them, for logs and for measuring real costs. */
  usage?: { inputTokens?: number; outputTokens?: number; images?: number };
  /** For usage_events.provider, e.g. "gemini". */
  provider: string;
  /** Model name, for logs. */
  model: string;
}

/** Generates "wearing it" previews. Built by outfit-engine (a Gemini image model). */
export interface ImageGenerationProvider {
  readonly name: string;
  /** `signal` aborts the call (the caller's time limit), so a timed-out call can't overlap the retry. */
  generatePreview(input: ImageGenerationInput, options?: { signal?: AbortSignal }): Promise<ImageGenerationCall>;
}
