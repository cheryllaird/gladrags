/**
 * The pipeline with gaps (milestone 5): fake ranking replies, no network.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { StyleChoice } from "@/contracts";
import { FakeRankingProvider } from "@/lib/ai/fakes";
import type { ModelCall } from "@/lib/ai/types";
import { ApiException } from "@/lib/api/errors";
import {
  BOOTS_GAP,
  INVENTED_ID,
  NO_SHOES,
  TRAINERS_GAP,
  W,
  WARDROBE,
  noShoesReplies,
  okResult,
} from "@/test/fixtures/outfit-engine";
import { entry, wardrobe } from "@/test/outfit-helpers";
import { seededRandom } from "./candidates";
import { MockRankingProvider } from "./mock-ranking";
import { runOutfitPipeline, type PipelineDeps, type PipelineInput } from "./pipeline";
import { PlaceholderThumbnailSource } from "./thumbnails";

const CASUAL: StyleChoice = { kind: "preset", presetId: "casual" };
const WORK: StyleChoice = { kind: "preset", presetId: "work" };
const AUTUMN = new Date("2026-10-25T12:00:00Z");

let costs: string[];
let starts: number;
let thumbnails: PlaceholderThumbnailSource;

beforeEach(() => {
  costs = [];
  starts = 0;
  thumbnails = new PlaceholderThumbnailSource();
});

function deps(ranking: FakeRankingProvider | MockRankingProvider): PipelineDeps {
  return {
    ranking: () => ranking,
    thumbnails,
    beforeAiCall: async () => {},
    recordAiCost: async (kind: string, _call: ModelCall) => {
      costs.push(kind);
    },
    onRankingStart: async () => {
      starts++;
    },
    random: seededRandom(1),
    now: () => AUTUMN,
  };
}

function input(overrides: Partial<PipelineInput> = {}): PipelineInput {
  return { items: WARDROBE, style: WORK, guidance: null, anchorItemId: null, count: 3, rejectedOutfits: [], ...overrides };
}

describe("a wardrobe without shoes", () => {
  it("offers candidates with a shoes gap, keeps the model's gap descriptions, and lists shoes as missing", async () => {
    const ranking = new FakeRankingProvider({ shortlist: [noShoesReplies.shortlist], final: [noShoesReplies.final] });
    const result = await runOutfitPipeline(input({ items: NO_SHOES }), deps(ranking));
    expect(result).toEqual(okResult(noShoesReplies.final.outfits, ["shoes"]));
    for (const c of ranking.shortlistCalls[0]!.candidates) expect(c.gaps).toEqual(["shoes"]);
    // Pass 2 sees pass 1's description as a suggestion for each gap.
    expect(ranking.finalCalls[0]!.shortlist[0]).toMatchObject({ itemIds: [W.top1, W.bottom1], gaps: [{ category: "shoes", suggestion: TRAINERS_GAP }] });
    expect(starts).toBe(1);
  });

  it("drops a made-up item ID, a dropped gap and a gap the wardrobe could fill, then retries once", async () => {
    const ranking = new FakeRankingProvider({
      shortlist: [noShoesReplies.shortlist],
      final: [noShoesReplies.finalBad, noShoesReplies.finalBad],
    });
    const result = await runOutfitPipeline(input({ items: NO_SHOES }), deps(ranking));
    expect(ranking.finalCalls).toHaveLength(2);
    expect(result).toEqual(okResult([noShoesReplies.finalBad.outfits[3]!], ["shoes"]));
    if (result.status === "ok") for (const o of result.outfits) expect(o.itemIds).not.toContain(INVENTED_ID);
    expect(costs).toEqual(["ranking_shortlist", "ranking_final", "ranking_final"]);
  });

  it("ai_failed when nothing valid comes back twice", async () => {
    const onlyBad = { outfits: noShoesReplies.finalBad.outfits.slice(0, 3) };
    const ranking = new FakeRankingProvider({ shortlist: [noShoesReplies.shortlist], final: [onlyBad] });
    const error = await runOutfitPipeline(input({ items: NO_SHOES }), deps(ranking)).catch((e: unknown) => e);
    expect((error as ApiException).code).toBe("ai_failed");
  });
});

describe("one item", () => {
  it("a single top still gets an outfit: the top with a bottom and shoes gap", async () => {
    const [top] = wardrobe({ top: 1 });
    const result = await runOutfitPipeline(input({ items: [top!], style: CASUAL }), deps(new MockRankingProvider()));
    expect(result).toMatchObject({ status: "ok", missingCategories: ["bottom", "shoes"] });
    if (result.status !== "ok") return;
    expect(result.outfits).toHaveLength(1);
    expect(result.outfits[0]!.itemIds).toEqual([top!.id]);
    expect(result.outfits[0]!.gaps.map((g) => g.category)).toEqual(["bottom", "shoes"]);
  });
});

describe("include items from my shops", () => {
  it("tells the model, offers one-shop-item candidates after the complete ones, and keeps nothing missing", async () => {
    const ranking = new MockRankingProvider();
    const shortlists: Parameters<MockRankingProvider["shortlist"]>[0][] = [];
    const inner = ranking.shortlist.bind(ranking);
    ranking.shortlist = async (i) => {
      shortlists.push(i);
      return inner(i);
    };
    const result = await runOutfitPipeline(input({ includeShopItems: true }), deps(ranking));
    expect(result).toMatchObject({ status: "ok", missingCategories: [] });
    const sent = shortlists[0]!;
    expect(sent.request.includeShopItems).toBe(true);
    const firstGap = sent.candidates.findIndex((c) => c.gaps.length > 0);
    expect(firstGap).toBeGreaterThan(0);
    expect(sent.candidates.slice(firstGap).every((c) => c.gaps.length === 1)).toBe(true);
  });

  it("without it, a complete wardrobe is offered no gaps at all", async () => {
    const ranking = new FakeRankingProvider({ shortlist: [{}], final: [{}] });
    await runOutfitPipeline(input(), deps(ranking)).catch(() => undefined);
    expect(ranking.shortlistCalls[0]!.candidates.every((c) => c.gaps.length === 0)).toBe(true);
    expect(ranking.shortlistCalls[0]!.request.includeShopItems).toBe(false);
  });

  it("puts complete outfits first in the result, whatever order the model gave", async () => {
    const items = wardrobe({ top: 1, bottom: 1, shoes: 1 });
    const [top, bottom, shoes] = items.map((i) => i.id) as [string, string, string];
    const final = {
      outfits: [
        { itemIds: [top, bottom], gaps: [BOOTS_GAP], name: "Boots", reason: "New boots" },
        { itemIds: [top, bottom, shoes], name: "Own", reason: "All yours" },
      ],
    };
    const result = await runOutfitPipeline(input({ items, style: CASUAL, includeShopItems: true, count: 3 }), deps(new FakeRankingProvider({ shortlist: [{}], final: [final] })));
    expect(result.status === "ok" && result.outfits.map((o) => o.name)).toEqual(["Own", "Boots"]);
  });
});

describe("filter levels prefer complete outfits", () => {
  it("brings in off-season shoes rather than making every outfit a shoes gap", async () => {
    const items = [...wardrobe({ top: 2, bottom: 2 }), ...wardrobe({ shoes: 2 }, { seasons: ["summer"] }, 20)];
    const ranking = new FakeRankingProvider({ shortlist: [{}], final: [{}] });
    await runOutfitPipeline(input({ items, count: 3 }), deps(ranking)).catch(() => undefined);
    const offered = ranking.finalCalls[0]?.shortlist ?? ranking.shortlistCalls[0]!.candidates;
    expect(offered.some((c) => c.gaps.length === 0)).toBe(true);
  });
});

describe("thumbnails", () => {
  it("pass 2 sends no picture for an item waiting for a photo (tags only)", async () => {
    const waiting = { ...entry(30, "bottom"), image: null };
    const items = [...wardrobe({ top: 1, shoes: 1 }), waiting];
    const ranking = new MockRankingProvider();
    const finals: Parameters<MockRankingProvider["pickFinal"]>[0][] = [];
    const inner = ranking.pickFinal.bind(ranking);
    ranking.pickFinal = async (i) => {
      finals.push(i);
      return inner(i);
    };
    const result = await runOutfitPipeline(input({ items, style: CASUAL }), deps(ranking));
    expect(result.status).toBe("ok");
    const withWaiting = finals[0]!.shortlist.find((o) => o.itemIds.includes(waiting.id))!;
    expect(withWaiting.thumbnails.map((t) => t.itemId)).not.toContain(waiting.id);
    expect(withWaiting.thumbnails.length).toBe(withWaiting.itemIds.length - 1);
  });
});
