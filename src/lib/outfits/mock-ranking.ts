/**
 * Mock mode's ranking "model": no network, no cost. It shortlists the first
 * candidates (code has already shuffled them, complete outfits first) and
 * names the picks from canned copy, so the UI agents get the real
 * pipeline's behaviour (filter, candidates, gaps, validation, refinement,
 * avoid hints) with predictable text. Gaps get a plain canned description
 * per slot.
 */
import type { Category, GapDescription } from "@/contracts";
import type { FinalPickInput, ModelCall, RankingProvider, ShortlistInput } from "@/lib/ai/types";
import { MOCK_OUTFIT_COPY } from "@/lib/mocks/fixtures";

/** What the mock "model" suggests for each gap slot. */
export const MOCK_GAP_DESCRIPTIONS: Record<Category, GapDescription> = {
  top: { category: "top", subcategory: "t_shirt", colours: ["white"], description: "Plain white t-shirt" },
  bottom: { category: "bottom", subcategory: "jeans", colours: ["blue"], description: "Straight-leg blue jeans" },
  dress_jumpsuit: { category: "dress_jumpsuit", subcategory: "dress", colours: ["black"], description: "Simple black midi dress" },
  outerwear: { category: "outerwear", subcategory: "jacket", colours: ["navy"], description: "Navy cotton jacket" },
  shoes: { category: "shoes", subcategory: "trainers", colours: ["white"], description: "White leather trainers" },
};

export class MockRankingProvider implements RankingProvider {
  readonly name = "mock";

  async shortlist(input: ShortlistInput): Promise<ModelCall> {
    const outfits = input.candidates.slice(0, input.shortlistSize).map(({ itemIds, gaps }) => ({
      itemIds,
      gaps: gaps.map((category) => MOCK_GAP_DESCRIPTIONS[category]),
    }));
    return { raw: { outfits }, costPence: 0, provider: this.name, model: "mock-ranker" };
  }

  async pickFinal(input: FinalPickInput): Promise<ModelCall> {
    const outfits = input.shortlist.slice(0, input.count).map(({ itemIds, gaps }, i) => {
      const copy = MOCK_OUTFIT_COPY[i % MOCK_OUTFIT_COPY.length]!;
      return {
        itemIds,
        gaps: gaps.map((g) => g.suggestion ?? MOCK_GAP_DESCRIPTIONS[g.category]),
        name: copy.name,
        reason: copy.reason,
      };
    });
    return { raw: { outfits }, costPence: 0, provider: this.name, model: "mock-ranker" };
  }
}
