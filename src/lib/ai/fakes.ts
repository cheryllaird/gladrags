/**
 * Fake providers that return recorded outputs instead of calling a model.
 * Used by unit tests and mock mode. No network.
 */
import type {
  FinalPickInput,
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
