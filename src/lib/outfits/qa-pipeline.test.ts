/**
 * QA gap tests for validation and the single retry (pipeline step 4), item
 * refs through the real Gemini provider (scripted, no network), costing of
 * failed calls, and anchor-aware missing categories.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { GenerateContentParameters } from "@google/genai";
import type { StyleChoice } from "@/contracts";
import { GeminiRankingProvider, type GeminiContentGenerator } from "@/lib/ai/gemini-ranking";
import { FakeRankingProvider } from "@/lib/ai/fakes";
import type { ModelCall, RankingProvider } from "@/lib/ai/types";
import { ApiException } from "@/lib/api/errors";
import { INVENTED_ID, W, WARDROBE, shortlistReplies } from "@/test/fixtures/outfit-engine";
import { entry, wardrobe } from "@/test/outfit-helpers";
import { seededRandom } from "./candidates";
import { runOutfitPipeline, type PipelineDeps, type PipelineInput } from "./pipeline";
import { PlaceholderThumbnailSource } from "./thumbnails";

const WORK: StyleChoice = { kind: "preset", presetId: "work" };
const AUTUMN = new Date("2026-10-25T12:00:00Z");

let costs: { kind: string; call: ModelCall }[];
let starts: number;

beforeEach(() => {
  costs = [];
  starts = 0;
});

function deps(ranking: RankingProvider): PipelineDeps {
  return {
    ranking: () => ranking,
    thumbnails: new PlaceholderThumbnailSource(),
    recordAiCost: async (kind, call) => {
      costs.push({ kind, call });
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

async function expectAiFailed(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ApiException);
  expect((error as ApiException).code).toBe("ai_failed");
}

const named = (itemIds: string[], name = "Pick") => ({ itemIds, name, reason: "Because" });

// Bad final picks for a request built around the coat (W.coat).
const BAD_AROUND_COAT = {
  invalidId: { outfits: [named([W.top1, W.bottom1, INVENTED_ID, W.coat])] },
  duplicate: { outfits: [named([W.dress, W.shoes2, W.coat, W.coat])] },
  brokenComposition: { outfits: [named([W.top1, W.dress, W.shoes1, W.coat])] },
  missingAnchor: { outfits: [named([W.top1, W.bottom1, W.shoes1])] },
} as const;
type BadKind = keyof typeof BAD_AROUND_COAT;
const KINDS = Object.keys(BAD_AROUND_COAT) as BadKind[];

describe("QA validation: every kind of bad pick shares ONE retry (never a 3rd call)", () => {
  for (const first of KINDS) {
    for (const second of KINDS) {
      it(`pass 2: ${first} then ${second} -> 2 calls, ai_failed`, async () => {
        const ranking = new FakeRankingProvider({
          shortlist: [shortlistReplies.aroundCoat],
          final: [BAD_AROUND_COAT[first], BAD_AROUND_COAT[second], { outfits: [named([W.top1, W.bottom1, W.shoes1, W.coat])] }],
        });
        await expectAiFailed(runOutfitPipeline(input({ anchorItemId: W.coat }), deps(ranking)));
        expect(ranking.finalCalls).toHaveLength(2);
        expect(costs.filter((c) => c.kind === "ranking_final")).toHaveLength(2);
      });
    }
  }

  for (const kind of KINDS) {
    it(`pass 1: ${kind} twice -> 2 shortlist calls, pass 2 never runs`, async () => {
      const shortlistBad = { outfits: BAD_AROUND_COAT[kind].outfits.map((o) => ({ itemIds: o.itemIds })) };
      const ranking = new FakeRankingProvider({ shortlist: [shortlistBad, shortlistBad, shortlistReplies.aroundCoat], final: [{}] });
      await expectAiFailed(runOutfitPipeline(input({ anchorItemId: W.coat }), deps(ranking)));
      expect(ranking.shortlistCalls).toHaveLength(2);
      expect(ranking.finalCalls).toHaveLength(0);
    });
  }

  it("a bad pass 1 and a bad pass 2 each get their own single retry (4 calls at most)", async () => {
    const ranking = new FakeRankingProvider({
      shortlist: [{ outfits: [{ itemIds: [W.top1, INVENTED_ID, W.shoes1, W.coat] }] }, shortlistReplies.aroundCoat],
      final: [BAD_AROUND_COAT.missingAnchor, { outfits: [named([W.top1, W.bottom1, W.shoes1, W.coat])] }],
    });
    const result = await runOutfitPipeline(input({ anchorItemId: W.coat }), deps(ranking));
    expect(result.status).toBe("ok");
    expect(ranking.shortlistCalls).toHaveLength(2);
    expect(ranking.finalCalls).toHaveLength(2);
    expect(costs.map((c) => c.kind)).toEqual(["ranking_shortlist", "ranking_shortlist", "ranking_final", "ranking_final"]);
    expect(starts).toBe(1);
  });
});

describe("QA validation: partial-good results keep the good ones", () => {
  const good = named([W.top1, W.bottom1, W.shoes1, W.coat], "Good");

  it("semantic problems on both attempts: keeps the second attempt's good picks", async () => {
    const ranking = new FakeRankingProvider({
      shortlist: [shortlistReplies.aroundCoat],
      final: [
        { outfits: [BAD_AROUND_COAT.missingAnchor.outfits[0]] },
        { outfits: [good, BAD_AROUND_COAT.invalidId.outfits[0], BAD_AROUND_COAT.brokenComposition.outfits[0]] },
      ],
    });
    const result = await runOutfitPipeline(input({ anchorItemId: W.coat }), deps(ranking));
    expect(result).toEqual({ status: "ok", outfits: [good] });
  });

  it("a good pick on attempt 1 survives when attempt 2 throws", async () => {
    let calls = 0;
    const ranking: RankingProvider = {
      name: "scripted",
      shortlist: async () => ({ raw: shortlistReplies.aroundCoat, provider: "scripted", model: "s" }),
      pickFinal: async () => {
        calls++;
        if (calls === 1) return { raw: { outfits: [good, BAD_AROUND_COAT.missingAnchor.outfits[0]] }, provider: "scripted", model: "s" };
        throw new Error("503 high demand");
      },
    };
    const result = await runOutfitPipeline(input({ anchorItemId: W.coat }), deps(ranking));
    expect(result).toEqual({ status: "ok", outfits: [good] });
    expect(calls).toBe(2);
  });

  it("all bad on both attempts: ai_failed", async () => {
    const ranking = new FakeRankingProvider({
      shortlist: [shortlistReplies.aroundCoat],
      final: [{ outfits: [BAD_AROUND_COAT.invalidId.outfits[0], BAD_AROUND_COAT.missingAnchor.outfits[0]] }],
    });
    await expectAiFailed(runOutfitPipeline(input({ anchorItemId: W.coat }), deps(ranking)));
  });

  // Was FINDING (medium), fixed: each outfit is now parsed on its own, so a
  // schema problem in one (an item twice, a name over 40 characters, a
  // non-UUID ref) no longer loses the good outfits next to it.
  it("keeps the good outfit when the other one repeats an item, on both attempts", async () => {
    const reply = { outfits: [good, BAD_AROUND_COAT.duplicate.outfits[0]] };
    const ranking = new FakeRankingProvider({ shortlist: [shortlistReplies.aroundCoat], final: [reply] });
    const result = await runOutfitPipeline(input({ anchorItemId: W.coat }), deps(ranking));
    expect(result).toEqual({ status: "ok", outfits: [good] });
  });

  it("keeps the good outfits when one name is too long, on both attempts", async () => {
    const longName = named([W.dress, W.shoes2, W.coat], "An extremely long outfit name that goes on and on");
    const ranking = new FakeRankingProvider({ shortlist: [shortlistReplies.aroundCoat], final: [{ outfits: [good, longName] }] });
    const result = await runOutfitPipeline(input({ anchorItemId: W.coat }), deps(ranking));
    expect(result).toEqual({ status: "ok", outfits: [good] });
  });
});

describe("QA caps inside the pipeline: failed model calls are still costed and counted", () => {
  it("pass 1 throws twice: the request is counted once and both calls are costed (estimate)", async () => {
    const ranking: RankingProvider = {
      name: "gemini",
      shortlist: async () => {
        throw new Error("timeout");
      },
      pickFinal: async () => {
        throw new Error("should not be called");
      },
    };
    await expectAiFailed(runOutfitPipeline(input(), deps(ranking)));
    expect(starts).toBe(1);
    expect(costs.map((c) => c.kind)).toEqual(["ranking_shortlist", "ranking_shortlist"]);
    for (const c of costs) {
      expect(c.call.costPence).toBeUndefined(); // so the guard uses the estimate
      expect(c.call.provider).toBe("gemini");
    }
  });

  it("nothing_fits and missing_category never start ranking", async () => {
    const lounge = wardrobe({ top: 2, bottom: 2, shoes: 2 }, { formality: 1, occasions: ["comfy"] });
    const ranking = new FakeRankingProvider({ shortlist: [{}], final: [{}] });
    const r1 = await runOutfitPipeline(input({ items: lounge, style: { kind: "preset", presetId: "formal_event" } }), deps(ranking));
    expect(r1).toMatchObject({ status: "incomplete_wardrobe", reason: "nothing_fits" });
    const r2 = await runOutfitPipeline(input({ items: wardrobe({ top: 2, bottom: 2 }) }), deps(ranking));
    expect(r2).toMatchObject({ status: "incomplete_wardrobe", reason: "missing_category", missingCategories: ["shoes"] });
    expect(starts).toBe(0);
    expect(costs).toEqual([]);
  });
});

describe("QA missing category is anchor-aware", () => {
  const cases: [string, Parameters<typeof wardrobe>[0], string, string[]][] = [
    ["top anchor, no bottoms but a dress", { top: 1, dress_jumpsuit: 1, shoes: 1 }, "top", ["bottom"]],
    ["bottom anchor, no tops but a dress", { bottom: 1, dress_jumpsuit: 1, shoes: 1 }, "bottom", ["top"]],
    ["dress anchor, no shoes", { dress_jumpsuit: 1, top: 1, bottom: 1 }, "dress_jumpsuit", ["shoes"]],
    ["shoes anchor, nothing to wear", { shoes: 2, outerwear: 1 }, "shoes", ["top", "bottom"]],
    ["outerwear anchor, only a top and shoes", { outerwear: 1, top: 1, shoes: 1 }, "outerwear", ["bottom"]],
  ];
  for (const [name, counts, anchorCategory, missing] of cases) {
    it(name, async () => {
      const items = wardrobe(counts);
      const anchor = items.find((i) => i.tags.category === anchorCategory)!;
      const ranking = new FakeRankingProvider({ shortlist: [{}], final: [{}] });
      const result = await runOutfitPipeline(input({ items, anchorItemId: anchor.id }), deps(ranking));
      expect(result).toEqual({ status: "incomplete_wardrobe", reason: "missing_category", missingCategories: missing });
      expect(starts).toBe(0);
    });
  }

  it("a top anchor with a dress and shoes but no bottoms doesn't fall back to the dress", async () => {
    const items = wardrobe({ top: 1, dress_jumpsuit: 3, shoes: 2 });
    const result = await runOutfitPipeline(
      input({ items, anchorItemId: items[0]!.id }),
      deps(new FakeRankingProvider({ shortlist: [{}], final: [{}] })),
    );
    expect(result).toMatchObject({ reason: "missing_category", missingCategories: ["bottom"] });
  });
});

// -------------------------------------------------------------------------
// Item refs (I1, I2, ...) through the real Gemini provider, scripted.
// -------------------------------------------------------------------------

/** Reads the refs out of the prompt and answers as a model might. */
class ScriptedGemini implements GeminiContentGenerator {
  readonly prompts: GenerateContentParameters[] = [];
  constructor(private readonly answer: (data: { candidates?: string[][]; shortlist?: string[][]; anchor: string | null }, call: number) => unknown) {}

  async generateContent(params: GenerateContentParameters) {
    this.prompts.push(params);
    const contents = params.contents as { parts: { text?: string }[] }[];
    const data = JSON.parse(contents[0]!.parts[0]!.text!);
    return { text: JSON.stringify(this.answer(data, this.prompts.length)) };
  }
}

const wardrobeIds = new Set(WARDROBE.map((i) => i.id));
const REF = /^I\d+$/;

describe("QA item refs never leak and can't map outside the wardrobe", () => {
  it("maps refs back to wardrobe IDs; made-up refs and outside UUIDs are dropped", async () => {
    const outsider = "2b000000-0000-4000-8000-000000000999"; // looks real, not in this wardrobe
    const gemini = new ScriptedGemini((data, call) => {
      // Call 1: pass 1 with a made-up ref among six good outfits (enough: no retry).
      // Call 2: pass 2 with a real-looking UUID from outside. Call 3: retry, clean.
      if (data.candidates) {
        const good = data.candidates.slice(0, 6).map((itemIds) => ({ itemIds }));
        return { outfits: call === 1 ? [...good, { itemIds: ["I1", "I999", "I2"] }] : good };
      }
      const [a, b, c] = data.shortlist!;
      return {
        outfits: [
          { itemIds: a, name: "One", reason: "First pick" },
          { itemIds: b, name: "Two", reason: "Second pick" },
          ...(call === 2 ? [{ itemIds: [...c!.slice(0, -1), outsider], name: "Three", reason: "Outsider" }] : []),
        ],
      };
    });
    const ranking = new GeminiRankingProvider(gemini, "test-model");
    const result = await runOutfitPipeline(input(), deps(ranking));
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    for (const outfit of result.outfits) {
      for (const id of outfit.itemIds) {
        expect(id).not.toMatch(REF);
        expect(wardrobeIds.has(id)).toBe(true);
      }
    }
    // The made-up ref (non-UUID) fails that outfit's schema and is dropped;
    // the other six are enough, so pass 1 isn't retried. The outsider in
    // pass 2 is rejected, leaving 2 of 3, so pass 2 is retried once.
    expect(gemini.prompts).toHaveLength(3);
    expect(result.outfits).toHaveLength(2);
  });

  // Was FINDING (medium), fixed with the duplicate-item case above: a
  // made-up ref only loses its own outfit, not the six good ones.
  it("one made-up ref on both pass 1 attempts still keeps the good shortlisted outfits", async () => {
    const gemini = new ScriptedGemini((data) => {
      if (data.candidates) return { outfits: [...data.candidates.slice(0, 6).map((itemIds) => ({ itemIds })), { itemIds: ["I1", "I999", "I2"] }] };
      return { outfits: [{ itemIds: data.shortlist![0], name: "One", reason: "First" }] };
    });
    const result = await runOutfitPipeline(input(), deps(new GeminiRankingProvider(gemini, "m")));
    expect(result.status).toBe("ok");
  });

  it("pass 2 refs are renumbered: 'I1' in pass 2 is the first shortlisted item, not the first wardrobe item", async () => {
    const gemini = new ScriptedGemini((data) => {
      if (data.candidates) return { outfits: data.candidates.slice(-8).map((itemIds) => ({ itemIds })) };
      return { outfits: [{ itemIds: data.shortlist![0], name: "One", reason: "First" }] };
    });
    const ranking = new GeminiRankingProvider(gemini, "test-model");
    const result = await runOutfitPipeline(input(), deps(ranking));
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    for (const id of result.outfits[0]!.itemIds) expect(wardrobeIds.has(id)).toBe(true);
  });

  it("no ref or UUID is sent where the user's text goes (prompt holds refs, not IDs)", async () => {
    const gemini = new ScriptedGemini((data) => {
      if (data.candidates) return { outfits: data.candidates.slice(0, 8).map((itemIds) => ({ itemIds })) };
      return { outfits: [{ itemIds: data.shortlist![0], name: "One", reason: "First" }] };
    });
    await runOutfitPipeline(input({ anchorItemId: W.coat }), deps(new GeminiRankingProvider(gemini, "m")));
    for (const prompt of gemini.prompts) {
      const text = JSON.stringify(prompt.contents);
      for (const id of wardrobeIds) expect(text).not.toContain(id);
    }
  });

  // Was FINDING (low), fixed: the prompt says not to mention refs, and a
  // pick whose name or reason shows one is treated as bad (dropped; the
  // good picks next to it are kept, and all-bad twice is ai_failed).
  it("doesn't show the model's item refs to the user in a name or reason", async () => {
    const gemini = new ScriptedGemini((data) => {
      if (data.candidates) return { outfits: data.candidates.slice(0, 8).map((itemIds) => ({ itemIds })) };
      const [first, second] = data.shortlist!;
      return {
        outfits: [
          { itemIds: first, name: `${first![0]} look`, reason: `${first![0]} and ${first![1]} keep this smart` },
          { itemIds: second, name: "Clean pick", reason: "Navy and tan keep this smart" },
        ],
      };
    });
    const result = await runOutfitPipeline(input(), deps(new GeminiRankingProvider(gemini, "m")));
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.outfits.map((o) => o.name)).toEqual(["Clean pick"]);
    for (const o of result.outfits) {
      expect(o.name).not.toMatch(/\bI\d+\b/);
      expect(o.reason).not.toMatch(/\bI\d+\b/);
    }
  });

  it("a reply where every pick shows refs is retried, then ai_failed", async () => {
    const gemini = new ScriptedGemini((data) => {
      if (data.candidates) return { outfits: data.candidates.slice(0, 8).map((itemIds) => ({ itemIds })) };
      const first = data.shortlist![0]!;
      return { outfits: [{ itemIds: first, name: `${first[0]} look`, reason: "Works" }] };
    });
    await expectAiFailed(runOutfitPipeline(input(), deps(new GeminiRankingProvider(gemini, "m"))));
    expect(gemini.prompts).toHaveLength(3); // pass 1 once, pass 2 twice
  });
});

describe("QA anchor of every category through the pipeline", () => {
  const items = wardrobe({ top: 3, bottom: 3, dress_jumpsuit: 2, shoes: 3, outerwear: 2 });
  for (const category of ["top", "bottom", "dress_jumpsuit", "shoes", "outerwear"] as const) {
    it(`every candidate sent to the model includes a ${category} anchor`, async () => {
      const anchor = items.find((i) => i.tags.category === category)!;
      const ranking = new FakeRankingProvider({ shortlist: [{}], final: [{}] });
      const seen: string[][] = [];
      ranking.shortlist = async (i) => {
        seen.push(...i.candidates);
        return { raw: { outfits: i.candidates.slice(0, 8).map((itemIds) => ({ itemIds })) }, provider: "f", model: "f" };
      };
      ranking.pickFinal = async (i) => {
        seen.push(...i.shortlist.map((o) => o.itemIds));
        return { raw: { outfits: [{ itemIds: i.shortlist[0]!.itemIds, name: "A", reason: "B" }] }, provider: "f", model: "f" };
      };
      const result = await runOutfitPipeline(input({ items, anchorItemId: anchor.id }), deps(ranking));
      expect(result.status).toBe("ok");
      expect(seen.length).toBeGreaterThan(0);
      for (const ids of seen) expect(ids).toContain(anchor.id);
    });
  }

  it("keeps an off-season, off-band anchor (formality 1 trainers for work)", async () => {
    const trainers = entry(500, "shoes", { subcategory: "trainers", formality: 1, seasons: ["summer"], occasions: ["active"] });
    const items = [...wardrobe({ top: 2, bottom: 2 }, { formality: 3 }), trainers];
    const ranking = new FakeRankingProvider({ shortlist: [{}], final: [{}] });
    ranking.pickFinal = async (i) => ({
      raw: { outfits: [{ itemIds: i.shortlist[0]!.itemIds, name: "A", reason: "B" }] },
      provider: "f",
      model: "f",
    });
    const result = await runOutfitPipeline(input({ items, anchorItemId: trainers.id }), deps(ranking));
    expect(result.status).toBe("ok");
  });
});
