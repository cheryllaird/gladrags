/**
 * QA gap tests for the filter (pipeline step 1) and the UK season: every
 * preset band, the occasion-tagged ±1 widening, the loosening order
 * (season first, then ±1), boundary dates, Holiday, and custom styles.
 */
import { describe, expect, it } from "vitest";
import { PRESET_STYLES, type PresetStyleId, type StyleChoice } from "@/contracts";
import { FakeRankingProvider } from "@/lib/ai/fakes";
import { entry, wardrobe } from "@/test/outfit-helpers";
import { seededRandom } from "./candidates";
import { FILTER_LEVELS, filterItems, fitsFormality } from "./filter";
import { runOutfitPipeline, type PipelineDeps, type PipelineInput } from "./pipeline";
import { seasonAt } from "./season";
import { PlaceholderThumbnailSource } from "./thumbnails";

const preset = (presetId: PresetStyleId): StyleChoice => ({ kind: "preset", presetId });

describe("QA filter: each preset band and the occasion-tagged ±1 widening", () => {
  for (const style of PRESET_STYLES) {
    it(`${style.id} (${style.formality.min}–${style.formality.max})`, () => {
      const { min, max } = style.formality;
      for (let formality = 1; formality <= 5; formality++) {
        const distance = formality < min ? min - formality : Math.max(0, formality - max);
        const untagged = entry(1, "top", { formality, occasions: [style.id === "comfy" ? "active" : "comfy"] }).tags;
        const tagged = entry(2, "top", { formality, occasions: [style.id] }).tags;
        expect(fitsFormality(untagged, preset(style.id)), `untagged f${formality}`).toBe(distance === 0);
        expect(fitsFormality(tagged, preset(style.id)), `tagged f${formality}`).toBe(distance <= 1);
        expect(fitsFormality(untagged, preset(style.id), true), `loose f${formality}`).toBe(distance <= 1);
      }
    });
  }

  it("a tag for a different occasion doesn't widen the band", () => {
    const blazer = entry(1, "outerwear", { formality: 4, occasions: ["work"] }).tags;
    expect(fitsFormality(blazer, preset("smart_casual"))).toBe(false);
  });
});

describe("QA season (UK, meteorological) on boundary dates", () => {
  it.each([
    ["2026-02-28T23:59:59Z", "winter"], // still Feb in London (GMT)
    ["2026-03-01T00:00:00Z", "spring"],
    ["2026-05-31T22:59:59Z", "spring"], // 23:59:59 BST, 31 May
    ["2026-05-31T23:00:00Z", "summer"], // 00:00 BST, 1 June
    ["2026-08-31T22:59:59Z", "summer"],
    ["2026-08-31T23:00:00Z", "autumn"],
    ["2026-11-30T23:59:59Z", "autumn"], // GMT again
    ["2026-12-01T00:00:00Z", "winter"],
    ["2027-01-01T00:00:00Z", "winter"],
    ["2028-02-29T12:00:00Z", "winter"], // leap day
  ])("%s is %s", (iso, season) => {
    expect(seasonAt(new Date(iso))).toBe(season);
  });
});

describe("QA filter: Holiday ignores the season, others don't", () => {
  const summerOnly = entry(1, "top", { formality: 2, seasons: ["summer"], occasions: ["holiday", "casual"] });
  it("keeps a summer-only item for holiday in winter, drops it for casual", () => {
    expect(filterItems([summerOnly], { style: preset("holiday"), season: "winter" })).toHaveLength(1);
    expect(filterItems([summerOnly], { style: preset("casual"), season: "winter" })).toHaveLength(0);
  });
  it("Holiday still filters formality", () => {
    const blackTie = entry(2, "top", { formality: 5, seasons: ["summer"], occasions: ["holiday"] });
    expect(filterItems([blackTie], { style: preset("holiday"), season: "summer" })).toHaveLength(0);
  });
});

describe("QA filter: custom styles", () => {
  const custom: StyleChoice = { kind: "custom", text: "garden party" };
  it("filters by season only, every formality kept", () => {
    const items = [1, 2, 3, 4, 5].map((f) => entry(f, "top", { formality: f }));
    const offSeason = entry(9, "top", { formality: 3, seasons: ["summer"] });
    const kept = filterItems([...items, offSeason], { style: custom, season: "winter" });
    expect(kept.map((i) => i.tags.formality)).toEqual([1, 2, 3, 4, 5]);
  });
});

// -------------------------------------------------------------------------
// Loosening order, through the pipeline (what the model is actually sent).
// -------------------------------------------------------------------------

const AUTUMN = new Date("2026-10-25T12:00:00Z");

function deps(ranking: FakeRankingProvider): PipelineDeps {
  return {
    ranking: () => ranking,
    thumbnails: new PlaceholderThumbnailSource(),
    beforeAiCall: async () => {},
    recordAiCost: async () => {},
    onRankingStart: async () => {},
    random: seededRandom(1),
    now: () => AUTUMN,
  };
}

function input(items: PipelineInput["items"], overrides: Partial<PipelineInput> = {}): PipelineInput {
  return { items, style: preset("work"), guidance: null, anchorItemId: null, count: 3, rejectedOutfits: [], ...overrides };
}

/** A fake model that picks the first shortlisted outfit, so the pipeline completes. */
function firstPick() {
  const ranking = new FakeRankingProvider({ shortlist: [{}], final: [{}] });
  ranking.pickFinal = async (i) => {
    ranking.finalCalls.push(i);
    return { raw: { outfits: [{ itemIds: i.shortlist[0]!.itemIds, name: "Pick", reason: "First" }] }, provider: "fake", model: "f" };
  };
  ranking.shortlist = async (i) => {
    ranking.shortlistCalls.push(i);
    return { raw: { outfits: i.candidates.slice(0, 8).map((itemIds) => ({ itemIds })) }, provider: "fake", model: "f" };
  };
  return ranking;
}

const sentItems = (r: FakeRankingProvider) =>
  new Set(r.shortlistCalls[0] ? r.shortlistCalls[0].items.map((i) => i.id) : r.finalCalls[0]!.shortlist.flat().flatMap((o) => o.itemIds));

describe("QA filter: loosening order is season first, then ±1", () => {
  it("FILTER_LEVELS are strict, then no season, then also loose formality", () => {
    expect(FILTER_LEVELS).toEqual([
      { ignoreSeason: false, looseFormality: false },
      { ignoreSeason: true, looseFormality: false },
      { ignoreSeason: true, looseFormality: true },
    ]);
  });

  it("drops the season before widening formality, when that's enough", async () => {
    // Work (3–4) in autumn. In season: too few. Ignoring season: plenty.
    // Untagged formality 2 items must NOT come in.
    const summer = wardrobe({ top: 3, bottom: 3, shoes: 2 }, { formality: 3, seasons: ["summer"], occasions: ["work"] });
    const casual = wardrobe({ top: 3, bottom: 3, shoes: 2 }, { formality: 2, occasions: ["casual"] }, 100);
    const ranking = firstPick();
    const result = await runOutfitPipeline(input([...summer, ...casual]), deps(ranking));
    expect(result.status).toBe("ok");
    const sent = sentItems(ranking);
    for (const item of summer) expect(sent.has(item.id)).toBe(true);
    for (const item of casual) expect(sent.has(item.id)).toBe(false);
  });

  it("widens to ±1 only once ignoring the season isn't enough", async () => {
    const work = wardrobe({ top: 1, bottom: 1, shoes: 1 }, { formality: 3, occasions: ["work"] });
    const nearly = wardrobe({ top: 2, bottom: 2 }, { formality: 2, occasions: ["casual"] }, 100);
    const ranking = firstPick();
    const result = await runOutfitPipeline(input([...work, ...nearly]), deps(ranking));
    expect(result.status).toBe("ok");
    const sent = sentItems(ranking);
    for (const item of nearly) expect(sent.has(item.id)).toBe(true);
  });

  it("never widens past ±1, even when that leaves too few", async () => {
    const work = wardrobe({ top: 1, bottom: 1, shoes: 1 }, { formality: 3, occasions: ["work"] });
    const lounge = wardrobe({ top: 3, bottom: 3 }, { formality: 1, occasions: ["comfy"] }, 100);
    const ranking = firstPick();
    const result = await runOutfitPipeline(input([...work, ...lounge]), deps(ranking));
    expect(result.status).toBe("ok");
    const sent = sentItems(ranking);
    for (const item of lounge) expect(sent.has(item.id)).toBe(false);
  });

  it("uses the strict level when it already gives enough (no off-season items sent)", async () => {
    const inSeason = wardrobe({ top: 3, bottom: 3, shoes: 2 }, { formality: 3, occasions: ["work"] });
    const summer = wardrobe({ top: 2 }, { formality: 3, seasons: ["summer"], occasions: ["work"] }, 100);
    const ranking = firstPick();
    await runOutfitPipeline(input([...inSeason, ...summer]), deps(ranking));
    const sent = sentItems(ranking);
    for (const item of summer) expect(sent.has(item.id)).toBe(false);
  });
});

describe("QA filter: custom style through the pipeline", () => {
  it("sends every formality (season only), but no candidate spans more than 2 points", async () => {
    const items = [
      ...wardrobe({ top: 2, bottom: 2, shoes: 2 }, { formality: 1 }),
      ...wardrobe({ top: 2, bottom: 2, shoes: 2 }, { formality: 5 }, 100),
      ...wardrobe({ top: 2 }, { formality: 3 }, 200),
      ...wardrobe({ top: 2 }, { formality: 3, seasons: ["summer"] }, 300),
    ];
    const ranking = firstPick();
    await runOutfitPipeline(input(items, { style: { kind: "custom", text: "garden party" } }), deps(ranking));
    const call = ranking.shortlistCalls[0]!;
    const formalities = new Set(call.items.map((i) => i.tags.formality));
    expect(formalities).toEqual(new Set([1, 3, 5]));
    expect(call.items.some((i) => i.tags.seasons.length === 1)).toBe(false);
    const byId = new Map(items.map((i) => [i.id, i.tags.formality]));
    for (const ids of call.candidates) {
      const f = ids.map((id) => byId.get(id)!);
      expect(Math.max(...f) - Math.min(...f)).toBeLessThanOrEqual(2);
    }
  });
});
