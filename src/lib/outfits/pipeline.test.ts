import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StyleChoice } from "@/contracts";
import { FakeRankingProvider } from "@/lib/ai/fakes";
import type { ModelCall, RankingProvider } from "@/lib/ai/types";
import { ApiException } from "@/lib/api/errors";
import { finalReplies, INVENTED_ID, shortlistReplies, W, WARDROBE } from "@/test/fixtures/outfit-engine";
import { okResult } from "@/test/fixtures/outfit-engine";
import { entry, wardrobe } from "@/test/outfit-helpers";
import { seededRandom } from "./candidates";
import { SHORTLIST_SIZE } from "./config";
import { runOutfitPipeline, type PipelineDeps, type PipelineInput } from "./pipeline";
import { PlaceholderThumbnailSource } from "./thumbnails";

const WORK: StyleChoice = { kind: "preset", presetId: "work" };
const AUTUMN = new Date("2026-10-25T12:00:00Z");

let costs: { kind: string; call: ModelCall }[];
let rankingStarts: number;
let thumbnails: PlaceholderThumbnailSource;

beforeEach(() => {
  costs = [];
  rankingStarts = 0;
  thumbnails = new PlaceholderThumbnailSource();
});

function deps(ranking: RankingProvider): PipelineDeps {
  return {
    ranking: () => ranking,
    thumbnails,
    beforeAiCall: async () => {},
    recordAiCost: async (kind, call) => {
      costs.push({ kind, call });
    },
    onRankingStart: async () => {
      rankingStarts++;
    },
    random: seededRandom(1),
    now: () => AUTUMN,
  };
}

function input(overrides: Partial<PipelineInput> = {}): PipelineInput {
  return {
    items: WARDROBE,
    style: WORK,
    guidance: null,
    anchorItemId: null,
    count: 3,
    rejectedOutfits: [],
    ...overrides,
  };
}

const fake = (shortlist: unknown[], final: unknown[]) => new FakeRankingProvider({ shortlist, final });

describe("two-pass ranking", () => {
  it("shortlists on tags, then picks the best N with thumbnails", async () => {
    const ranking = fake([shortlistReplies.valid], [finalReplies.valid]);
    const result = await runOutfitPipeline(input({ guidance: "no heels" }), deps(ranking));

    expect(result).toEqual(okResult(finalReplies.valid.outfits));

    const [pass1] = ranking.shortlistCalls;
    expect(pass1!.shortlistSize).toBe(SHORTLIST_SIZE);
    expect(pass1!.items.map((i) => i.id).sort()).toEqual(WARDROBE.map((i) => i.id).sort());
    expect(pass1!.candidates.length).toBe(40);
    expect(pass1!.request).toEqual({ style: WORK, guidance: "no heels", includeShopItems: false, anchorItemId: undefined });
    // Pass 1 sends tags only: no images anywhere in its input.
    expect(JSON.stringify(pass1)).not.toContain("image");

    const [pass2] = ranking.finalCalls;
    expect(pass2!.count).toBe(3);
    expect(pass2!.shortlist.map((o) => o.itemIds)).toEqual(shortlistReplies.valid.outfits.map((o) => o.itemIds));
    for (const outfit of pass2!.shortlist) {
      expect(outfit.thumbnails.map((t) => t.itemId)).toEqual(outfit.itemIds);
    }
    // Thumbnails are fetched once, only for the shortlisted items.
    expect(thumbnails.requested).toHaveLength(1);
    expect(new Set(thumbnails.requested[0])).toEqual(new Set(shortlistReplies.valid.outfits.flatMap((o) => o.itemIds)));

    expect(costs.map((c) => c.kind)).toEqual(["ranking_shortlist", "ranking_final"]);
    expect(rankingStarts).toBe(1);
  });

  it("skips pass 1 when there are only a few candidates", async () => {
    const items = wardrobe({ top: 1, bottom: 1, shoes: 2, dress_jumpsuit: 1 }); // 4 combinations
    const ranking = fake([shortlistReplies.valid], [{ outfits: [{ itemIds: [items[0]!.id, items[1]!.id, items[2]!.id], name: "Simple", reason: "Works" }] }]);
    const result = await runOutfitPipeline(input({ items }), deps(ranking));
    expect(result.status).toBe("ok");
    expect(ranking.shortlistCalls).toHaveLength(0);
    expect(ranking.finalCalls[0]!.shortlist).toHaveLength(4);
    expect(costs.map((c) => c.kind)).toEqual(["ranking_final"]);
  });

  it("returns no more outfits than asked for", async () => {
    // Shortlist exactly the outfits the final reply uses, so all five are valid.
    const all = { outfits: finalReplies.tooMany.outfits.map((o) => ({ itemIds: o.itemIds })) };
    const ranking = fake([all], [finalReplies.tooMany]);
    const result = await runOutfitPipeline(input({ count: 3 }), deps(ranking));
    expect(result.status === "ok" && result.outfits.map((o) => o.name)).toEqual(["One", "Two", "Three"]);
    expect(ranking.finalCalls).toHaveLength(1);
  });
});

describe("what pass 1 sees and may pick", () => {
  // 20 × 20 × 3 × 1 = 1,200 combinations, so only a sample of 60 is offered.
  const big = wardrobe({ top: 20, bottom: 20, shoes: 3 });

  it("sends only items that appear in a candidate (plus the anchor)", async () => {
    const anchor = big[0]!;
    const ranking = fake([{}], [{}]);
    await runOutfitPipeline(input({ items: big, anchorItemId: anchor.id }), deps(ranking)).catch(() => undefined);
    const pass1 = ranking.shortlistCalls[0]!;
    const inCandidates = new Set([...pass1.candidates.flatMap((c) => c.itemIds), anchor.id]);
    expect(pass1.items.length).toBeLessThan(big.length);
    for (const item of pass1.items) expect(inCandidates.has(item.id)).toBe(true);
  });

  it("rejects a wearable pick that wasn't one of the candidates", async () => {
    const ranking = new FakeRankingProvider({ shortlist: [{}], final: [{}] });
    let offered: string[][] = [];
    ranking.shortlist = async (i) => {
      offered = i.candidates.map((c) => c.itemIds);
      const keys = new Set(i.candidates.map((c) => [...c.itemIds].sort().join()));
      const tops = i.items.filter((x) => x.tags.category === "top");
      const bottoms = i.items.filter((x) => x.tags.category === "bottom");
      const shoes = i.items.filter((x) => x.tags.category === "shoes");
      // Find a wearable combination of offered items that isn't a candidate.
      for (const t of tops) for (const b of bottoms) for (const s of shoes) {
        const ids = [t.id, b.id, s.id];
        if (!keys.has([...ids].sort().join())) return { raw: { outfits: [{ itemIds: ids }] }, provider: "f", model: "f" };
      }
      throw new Error("test setup: every combination is a candidate");
    };
    await expect(runOutfitPipeline(input({ items: big }), deps(ranking))).rejects.toMatchObject({ code: "ai_failed" });
    expect(offered.length).toBeGreaterThan(0);
  });
});

describe("validation and the single retry", () => {
  it("retries pass 1 when the model invents an item ID", async () => {
    const ranking = fake([shortlistReplies.inventedItemId, shortlistReplies.valid], [finalReplies.valid]);
    const result = await runOutfitPipeline(input(), deps(ranking));
    expect(result.status).toBe("ok");
    expect(ranking.shortlistCalls).toHaveLength(2);
    expect(costs.map((c) => c.kind)).toEqual(["ranking_shortlist", "ranking_shortlist", "ranking_final"]);
  });

  it("after the retry, drops the bad outfits and keeps the good ones", async () => {
    const ranking = fake([shortlistReplies.valid], [finalReplies.inventedItemId]);
    const result = await runOutfitPipeline(input(), deps(ranking));
    expect(ranking.finalCalls).toHaveLength(2);
    expect(result).toEqual(okResult([finalReplies.inventedItemId.outfits[0]!]));
    // The invented ID never comes back.
    expect(JSON.stringify(result)).not.toContain(INVENTED_ID);
  });

  it("fails with ai_failed when both attempts have no valid outfit", async () => {
    const ranking = fake([shortlistReplies.valid], [finalReplies.allInvented]);
    await expect(runOutfitPipeline(input(), deps(ranking))).rejects.toMatchObject({ code: "ai_failed" });
    expect(ranking.finalCalls).toHaveLength(2);
    expect(costs.filter((c) => c.kind === "ranking_final")).toHaveLength(2);
  });

  it.each([
    ["prose", shortlistReplies.prose],
    ["truncated JSON", shortlistReplies.truncated],
    ["two tops", shortlistReplies.twoTops],
  ])("fails pass 1 after two bad replies (%s)", async (_label, reply) => {
    const ranking = fake([reply], [finalReplies.valid]);
    const error = await runOutfitPipeline(input(), deps(ranking)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiException);
    expect((error as ApiException).code).toBe("ai_failed");
    expect(ranking.shortlistCalls).toHaveLength(2);
    expect(ranking.finalCalls).toHaveLength(0);
  });

  it("retries when a name is longer than allowed", async () => {
    const ranking = fake([shortlistReplies.valid], [finalReplies.nameTooLong, finalReplies.valid]);
    const result = await runOutfitPipeline(input(), deps(ranking));
    expect(result.status).toBe("ok");
    expect(ranking.finalCalls).toHaveLength(2);
  });

  it("counts a provider error as a failed attempt and records its estimated cost", async () => {
    const ranking = fake([shortlistReplies.valid], [finalReplies.valid]);
    let calls = 0;
    vi.spyOn(ranking, "pickFinal").mockImplementation(async (i) => {
      if (calls++ === 0) throw new Error("503 high demand");
      return FakeRankingProvider.prototype.pickFinal.call(ranking, i);
    });
    const result = await runOutfitPipeline(input(), deps(ranking));
    expect(result.status).toBe("ok");
    const finals = costs.filter((c) => c.kind === "ranking_final");
    expect(finals).toHaveLength(2);
    expect(finals[0]!.call.costPence).toBeUndefined(); // the guard records the estimate
    expect(finals[0]!.call.error).toContain("503");
  });
});

describe("anchor item", () => {
  it("retries when the model leaves the anchor out, and every outfit has it", async () => {
    const ranking = fake([shortlistReplies.omitsAnchor, shortlistReplies.aroundCoat], [finalReplies.omitsAnchor, finalReplies.aroundCoat]);
    const result = await runOutfitPipeline(input({ anchorItemId: W.coat }), deps(ranking));
    expect(ranking.shortlistCalls).toHaveLength(2);
    expect(ranking.finalCalls).toHaveLength(2);
    expect(result.status).toBe("ok");
    if (result.status === "ok") for (const o of result.outfits) expect(o.itemIds).toContain(W.coat);
    for (const c of ranking.shortlistCalls[0]!.candidates) expect(c.itemIds).toContain(W.coat);
    expect(ranking.shortlistCalls[0]!.request.anchorItemId).toBe(W.coat);
  });

  it("keeps the anchor even when it doesn't suit the style", async () => {
    const gown = entry(50, "dress_jumpsuit", { formality: 5, occasions: ["formal_event"] });
    const items = [...WARDROBE, gown];
    const ranking = fake([{ outfits: [{ itemIds: [gown.id, W.shoes1] }] }], [{ outfits: [{ itemIds: [gown.id, W.shoes1], name: "Gown", reason: "As asked" }] }]);
    const result = await runOutfitPipeline(input({ items, anchorItemId: gown.id }), deps(ranking));
    expect(result.status).toBe("ok");
  });
});

describe("incomplete wardrobe (missing categories become gaps: see pipeline-gaps.test.ts)", () => {
  it("an empty wardrobe answers empty_wardrobe, without calling the model or counting the request", async () => {
    const ranking = fake([shortlistReplies.valid], [finalReplies.valid]);
    expect(await runOutfitPipeline(input({ items: [] }), deps(ranking))).toEqual({
      status: "incomplete_wardrobe",
      reason: "empty_wardrobe",
      missingCategories: [],
    });
    expect(ranking.shortlistCalls).toHaveLength(0);
    expect(ranking.finalCalls).toHaveLength(0);
    expect(rankingStarts).toBe(0);
  });

  it("reports nothing_fits when combinations exist but none suit the style", async () => {
    const ranking = fake([{}], [{}]);
    const formalOnly = wardrobe({ top: 2, bottom: 2, shoes: 2 }, { formality: 5, occasions: ["formal_event"] });
    const comfy: StyleChoice = { kind: "preset", presetId: "comfy" };
    expect(await runOutfitPipeline(input({ items: formalOnly, style: comfy }), deps(ranking))).toEqual({
      status: "incomplete_wardrobe",
      reason: "nothing_fits",
      missingCategories: [],
    });
    expect(rankingStarts).toBe(0);
  });

  it("reports nothing_fits when the anchor clashes with everything else", async () => {
    const gown = entry(50, "dress_jumpsuit", { formality: 5 });
    const trainers = entry(51, "shoes", { formality: 1, occasions: ["comfy"] });
    const comfy: StyleChoice = { kind: "preset", presetId: "comfy" };
    const result = await runOutfitPipeline(input({ items: [gown, trainers], style: comfy, anchorItemId: gown.id }), deps(fake([{}], [{}])));
    expect(result).toMatchObject({ reason: "nothing_fits" });
  });
});

describe("filter relaxing", () => {
  it("ignores the season rather than giving up", async () => {
    const summerShoes = wardrobe({ top: 1, bottom: 1 }).concat(wardrobe({ shoes: 1 }, { seasons: ["summer"] }, 10));
    const ranking = fake([{}], [{ outfits: [{ itemIds: summerShoes.map((i) => i.id), name: "Only option", reason: "All there is" }] }]);
    const result = await runOutfitPipeline(input({ items: summerShoes }), deps(ranking));
    expect(result.status).toBe("ok");
  });

  it("loosens formality when the strict filter leaves fewer candidates than asked for", async () => {
    // Casual (1–2): one strict combination; chinos and a shirt at 3 come in when loosened.
    const items = [
      entry(1, "top", { formality: 2, occasions: ["casual"] }),
      entry(2, "bottom", { formality: 2, occasions: ["casual"] }),
      entry(3, "shoes", { formality: 2, occasions: ["casual"] }),
      entry(4, "top", { formality: 3, occasions: ["work"] }),
      entry(5, "bottom", { formality: 3, occasions: ["work"] }),
    ];
    const casual: StyleChoice = { kind: "preset", presetId: "casual" };
    const ranking = fake([{}], [{ outfits: [{ itemIds: [items[0]!.id, items[1]!.id, items[2]!.id], name: "Easy", reason: "Relaxed" }] }]);
    await runOutfitPipeline(input({ items, style: casual, count: 3 }), deps(ranking));
    expect(ranking.finalCalls[0]!.shortlist).toHaveLength(4);
  });
});

describe("rejections and refinement", () => {
  it("sends rejected pairings as avoid hints and never offers a rejected outfit again", async () => {
    const rejected = [W.top1, W.bottom1, W.shoes1];
    const ranking = fake([shortlistReplies.valid], [finalReplies.valid]);
    const result = await runOutfitPipeline(input({ rejectedOutfits: [rejected] }), deps(ranking));

    const pass1 = ranking.shortlistCalls[0]!;
    expect(pass1.avoidPairs).toEqual([
      [W.top1, W.bottom1],
      [W.top1, W.shoes1],
      [W.bottom1, W.shoes1],
    ]);
    const key = (ids: string[]) => [...ids].sort().join();
    expect(pass1.candidates.map((c) => key(c.itemIds))).not.toContain(key(rejected));

    // The recorded replies start with the rejected outfit, so both passes
    // retry and then keep only their other outfits.
    expect(ranking.shortlistCalls).toHaveLength(2);
    expect(ranking.finalCalls).toHaveLength(2);
    expect(ranking.finalCalls[0]!.avoidPairs).toEqual(pass1.avoidPairs);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.outfits.length).toBeGreaterThan(0);
      for (const o of result.outfits) expect(key(o.itemIds)).not.toBe(key(rejected));
    }
  });

  it("a swap keeps the other items and passes the previous outfit and feedback", async () => {
    const previous = [W.top1, W.bottom1, W.shoes1];
    const items = WARDROBE.filter((i) => i.id !== W.shoes1);
    const swapPick = { outfits: [{ itemIds: [W.top1, W.bottom1, W.shoes2], name: "New shoes", reason: "Swapped" }] };
    const ranking = fake([{}], [swapPick]);
    const result = await runOutfitPipeline(
      input({
        items,
        keepItemIds: [W.top1, W.bottom1],
        excludeOutfits: [previous],
        refinement: { previousItemIds: previous, feedback: { kind: "swap", itemId: W.shoes1 } },
      }),
      deps(ranking),
    );
    expect(result).toEqual(okResult(swapPick.outfits));
    const pass2 = ranking.finalCalls[0]!;
    // Two options: shoes2 with and without the coat.
    expect(pass2.shortlist.map((o) => o.itemIds.slice(0, 3))).toEqual([
      [W.top1, W.bottom1, W.shoes2],
      [W.top1, W.bottom1, W.shoes2],
    ]);
    expect(pass2.refinement).toEqual({ previousItemIds: previous, feedback: { kind: "swap", itemId: W.shoes1 } });
  });

  it("a swap rejects picks that drop a kept item", async () => {
    const items = WARDROBE.filter((i) => i.id !== W.shoes1);
    const dropsKept = { outfits: [{ itemIds: [W.dress, W.shoes2], name: "Different", reason: "Dropped the top" }] };
    const ranking = fake([{}], [dropsKept]);
    await expect(
      runOutfitPipeline(input({ items, keepItemIds: [W.top1, W.bottom1] }), deps(ranking)),
    ).rejects.toMatchObject({ code: "ai_failed" });
  });

  it("a swap keeps the other items with a gap when nothing in the wardrobe can replace the swapped one", async () => {
    // Swapping the only top: the bottom and shoes stay, and the top becomes
    // a gap the model describes (not the dress, which would drop them).
    const items = wardrobe({ bottom: 1, shoes: 1, dress_jumpsuit: 1 });
    const [bottom, shoes] = items.map((i) => i.id) as [string, string, string];
    const topGap = { category: "top", subcategory: "shirt", colours: ["white"], description: "Crisp white shirt" } as const;
    const pick = { outfits: [{ itemIds: [bottom, shoes], gaps: [topGap], name: "New top", reason: "A white shirt keeps it easy" }] };
    const ranking = fake([{}], [pick]);
    const result = await runOutfitPipeline(input({ items, keepItemIds: [bottom, shoes] }), deps(ranking));
    // No anchor, and the wardrobe has a dress, so nothing is "missing" for
    // outfits in general (missingCategoriesForOutfits); the swap's own gap shows on the outfit.
    expect(result).toEqual(okResult(pick.outfits));
    expect(ranking.finalCalls[0]!.shortlist).toEqual([{ itemIds: [bottom, shoes], gaps: [{ category: "top" }], thumbnails: expect.any(Array) }]);
  });

  it("a swap lets the kept items go when they can't make any outfit", async () => {
    // Keeping both tops' partner is impossible: two kept items in one slot.
    const items = wardrobe({ top: 2, bottom: 1, shoes: 1, dress_jumpsuit: 1 });
    const [top1, top2, , shoes, dress] = items.map((i) => i.id) as [string, string, string, string, string];
    const pick = { outfits: [{ itemIds: [dress, shoes], name: "Dress instead", reason: "Simple" }] };
    const ranking = fake([{}], [pick]);
    const result = await runOutfitPipeline(input({ items, keepItemIds: [top1, top2] }), deps(ranking));
    expect(result).toMatchObject({ status: "ok" });
    expect(ranking.finalCalls[0]!.shortlist.some((o) => o.itemIds.includes(dress))).toBe(true);
  });

  it("guidance refinement never returns the outfit being refined", async () => {
    const previous = [W.top1, W.bottom1, W.shoes1];
    const ranking = fake([shortlistReplies.valid], [finalReplies.valid]);
    await runOutfitPipeline(
      input({ excludeOutfits: [previous], guidance: "warmer", refinement: { previousItemIds: previous, feedback: { kind: "guidance", text: "warmer" } } }),
      deps(ranking),
    );
    // shortlistReplies.valid starts with the previous outfit: pass 1 is retried.
    expect(ranking.shortlistCalls).toHaveLength(2);
  });
});
