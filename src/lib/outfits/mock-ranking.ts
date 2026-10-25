/**
 * Mock mode's ranking "model": no network, no cost. It shortlists the first
 * candidates (code has already shuffled them) and names the picks from
 * canned copy, so the UI agents get the real pipeline's behaviour (filter,
 * candidates, validation, refinement, avoid hints) with predictable text.
 */
import type { FinalPickInput, ModelCall, RankingProvider, ShortlistInput } from "@/lib/ai/types";
import { MOCK_OUTFIT_COPY } from "@/lib/mocks/fixtures";

export class MockRankingProvider implements RankingProvider {
  readonly name = "mock";

  async shortlist(input: ShortlistInput): Promise<ModelCall> {
    const outfits = input.candidates.slice(0, input.shortlistSize).map((itemIds) => ({ itemIds }));
    return { raw: { outfits }, costPence: 0, provider: this.name, model: "mock-ranker" };
  }

  async pickFinal(input: FinalPickInput): Promise<ModelCall> {
    const outfits = input.shortlist.slice(0, input.count).map(({ itemIds }, i) => {
      const copy = MOCK_OUTFIT_COPY[i % MOCK_OUTFIT_COPY.length]!;
      return { itemIds, name: copy.name, reason: copy.reason };
    });
    return { raw: { outfits }, costPence: 0, provider: this.name, model: "mock-ranker" };
  }
}
