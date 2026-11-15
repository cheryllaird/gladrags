/**
 * Fake providers that return recorded outputs instead of calling a model.
 * Used by unit tests and mock mode. No network.
 */
import type {
  FinalPickInput,
  ImageGenerationCall,
  ImageGenerationInput,
  ImageGenerationProvider,
  ModelCall,
  OrderEmailInput,
  OrderEmailProvider,
  RankingProvider,
  ShopSearchInput,
  ShopSearchProvider,
  ShortlistInput,
  TaggingInput,
  TaggingProvider,
} from "./types";

/** Returns the queued outputs in order, then repeats the last one. */
function queue(outputs: unknown[]): () => unknown {
  if (outputs.length === 0) throw new Error("A fake provider needs at least one output");
  let index = 0;
  return () => outputs[Math.min(index++, outputs.length - 1)];
}

export class FakeTaggingProvider implements TaggingProvider {
  readonly name = "fake";
  readonly calls: TaggingInput[] = [];
  private readonly next: () => unknown;

  constructor(outputs: unknown[]) {
    this.next = queue(outputs);
  }

  async tagItem(input: TaggingInput): Promise<ModelCall> {
    this.calls.push(input);
    return { raw: this.next(), costPence: 0, provider: this.name, model: "fake-tagger" };
  }
}

export class FakeRankingProvider implements RankingProvider {
  readonly name = "fake";
  readonly shortlistCalls: ShortlistInput[] = [];
  readonly finalCalls: FinalPickInput[] = [];
  private readonly nextShortlist: () => unknown;
  private readonly nextFinal: () => unknown;

  constructor(outputs: { shortlist: unknown[]; final: unknown[] }) {
    this.nextShortlist = queue(outputs.shortlist);
    this.nextFinal = queue(outputs.final);
  }

  async shortlist(input: ShortlistInput): Promise<ModelCall> {
    this.shortlistCalls.push(input);
    return { raw: this.nextShortlist(), costPence: 0, provider: this.name, model: "fake-ranker" };
  }

  async pickFinal(input: FinalPickInput): Promise<ModelCall> {
    this.finalCalls.push(input);
    return { raw: this.nextFinal(), costPence: 0, provider: this.name, model: "fake-ranker" };
  }
}

export class FakeOrderEmailProvider implements OrderEmailProvider {
  readonly name = "fake";
  readonly calls: OrderEmailInput[] = [];
  private readonly next: () => unknown;

  constructor(outputs: unknown[]) {
    this.next = queue(outputs);
  }

  async extractOrder(input: OrderEmailInput): Promise<ModelCall> {
    this.calls.push(input);
    return { raw: this.next(), costPence: 0, provider: this.name, model: "fake-email-reader" };
  }
}

export class FakeShopSearchProvider implements ShopSearchProvider {
  readonly name = "fake";
  readonly calls: ShopSearchInput[] = [];
  private readonly next: () => unknown;

  constructor(outputs: unknown[]) {
    this.next = queue(outputs);
  }

  async searchGaps(input: ShopSearchInput): Promise<ModelCall> {
    this.calls.push(input);
    return { raw: this.next(), costPence: 0, provider: this.name, model: "fake-shop-search" };
  }
}

/**
 * One recorded reply for FakeImageGenerationProvider: an image (see
 * src/lib/ai/fixtures/preview-fixtures.ts for recorded ones), a refusal,
 * no image at all, or "throw" for a provider error.
 */
export type FakeImageReply =
  | { image: { data: Uint8Array; mimeType: string }; costPence?: number }
  | { blocked: string }
  | { noImage: true }
  | "throw";

export class FakeImageGenerationProvider implements ImageGenerationProvider {
  readonly name = "fake";
  readonly calls: ImageGenerationInput[] = [];
  private readonly next: () => unknown;

  constructor(replies: FakeImageReply[]) {
    this.next = queue(replies);
  }

  async generatePreview(input: ImageGenerationInput, _options?: { signal?: AbortSignal }): Promise<ImageGenerationCall> {
    this.calls.push(input);
    const reply = this.next() as FakeImageReply;
    const base = { provider: this.name, model: "fake-image-model" };
    if (reply === "throw") throw new Error("Fake image model error");
    if ("blocked" in reply) return { ...base, image: null, blockReason: reply.blocked, costPence: 0 };
    if ("noImage" in reply) return { ...base, image: null, costPence: 0 };
    return { ...base, image: reply.image, costPence: reply.costPence ?? 0, usage: { images: 1 } };
  }
}
