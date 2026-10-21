import { describe, expect, it } from "vitest";
import {
  RankingFinalOutputSchema,
  RankingShortlistOutputSchema,
  TaggingModelOutputSchema,
  checkRankedOutfits,
  parseModelOutput,
  type Category,
} from "@/contracts";
import { ITEM_IDS, finalPick, shortlist, tagging } from "@/test/fixtures/model-output";

describe("tagging model output", () => {
  it("accepts valid tags", () => {
    expect(parseModelOutput(TaggingModelOutputSchema, tagging.valid)).toEqual({ success: true, data: tagging.valid });
  });

  it("accepts raw JSON text in a code fence and strips extra keys", () => {
    const result = parseModelOutput(TaggingModelOutputSchema, tagging.validFencedWithExtraKey);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.subcategory).toBe("loafers");
      expect(result.data).not.toHaveProperty("confidence");
    }
  });

  it.each([
    ["a category outside v1 (accessories)", tagging.invalidCategory],
    ["a subcategory from the wrong category", tagging.subcategoryFromWrongCategory],
    ["an invented colour", tagging.inventedColour],
    ["formality as a word", tagging.formalityAsString],
    ["formality out of range", tagging.formalityOutOfRange],
    ["missing fields", tagging.missingFields],
    ["an occasion that isn't a preset", tagging.unknownOccasion],
    ["a multi-line description (prompt injection)", tagging.multiLineDescription],
    ["truncated JSON", tagging.truncatedJson],
    ["prose instead of JSON", tagging.prose],
    ["null", null],
    ["an array", [tagging.valid]],
  ])("rejects %s", (_label, raw) => {
    const result = parseModelOutput(TaggingModelOutputSchema, raw);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.length).toBeGreaterThan(0);
  });
});

describe("ranking pass 1 (shortlist) output", () => {
  it("accepts a shortlist of outfits by item ID", () => {
    expect(parseModelOutput(RankingShortlistOutputSchema, shortlist.valid).success).toBe(true);
  });

  it("accepts the same as a JSON string", () => {
    expect(parseModelOutput(RankingShortlistOutputSchema, JSON.stringify(shortlist.valid)).success).toBe(true);
  });

  it.each([
    ["an empty shortlist", shortlist.empty],
    ["IDs that aren't UUIDs", shortlist.notUuids],
    ["the same item twice in one outfit", shortlist.duplicateItem],
    ["five items in one outfit", shortlist.tooManyItems],
    ["a bare array instead of { outfits }", shortlist.wrongShape],
  ])("rejects %s", (_label, raw) => {
    expect(parseModelOutput(RankingShortlistOutputSchema, raw).success).toBe(false);
  });

  it("rejects more than 10 shortlisted outfits", () => {
    const many = { outfits: Array.from({ length: 11 }, () => shortlist.valid.outfits[0]) };
    expect(parseModelOutput(RankingShortlistOutputSchema, many).success).toBe(false);
  });
});

describe("ranking pass 2 (final pick) output", () => {
  it("accepts named, explained outfits", () => {
    expect(parseModelOutput(RankingFinalOutputSchema, finalPick.valid).success).toBe(true);
  });

  it.each([
    ["a missing reason", finalPick.missingReason],
    ["a name over 40 characters", finalPick.nameTooLong],
    ["more than five outfits", finalPick.tooMany],
  ])("rejects %s", (_label, raw) => {
    expect(parseModelOutput(RankingFinalOutputSchema, raw).success).toBe(false);
  });
});

describe("checkRankedOutfits (unknown IDs and composition)", () => {
  const known = new Map<string, Category>([
    [ITEM_IDS.shirt, "top"],
    [ITEM_IDS.jeans, "bottom"],
    [ITEM_IDS.chinos, "bottom"],
    [ITEM_IDS.dress, "dress_jumpsuit"],
    [ITEM_IDS.blazer, "outerwear"],
    [ITEM_IDS.loafers, "shoes"],
    [ITEM_IDS.trainers, "shoes"],
  ]);

  it("keeps valid outfits", () => {
    const { valid, rejected } = checkRankedOutfits(shortlist.valid.outfits, known);
    expect(valid).toHaveLength(3);
    expect(rejected).toHaveLength(0);
  });

  it("rejects an outfit with an item ID the model invented", () => {
    const invented = { itemIds: [ITEM_IDS.shirt, ITEM_IDS.chinos, "9f000000-0000-4000-8000-000000000000"] };
    const { valid, rejected } = checkRankedOutfits([invented], known);
    expect(valid).toHaveLength(0);
    expect(rejected[0]?.problem).toMatch(/Unknown item/);
  });

  it("rejects an outfit with an item from outside the allowed set (e.g. filtered out)", () => {
    const filteredOut = { itemIds: [ITEM_IDS.shirt, ITEM_IDS.chinos, ITEM_IDS.loafers, ITEM_IDS.coat] };
    expect(checkRankedOutfits([filteredOut], known).rejected).toHaveLength(1);
  });

  it("rejects an outfit that breaks the composition rule", () => {
    const noShoes = { itemIds: [ITEM_IDS.shirt, ITEM_IDS.chinos] };
    const twoBottoms = { itemIds: [ITEM_IDS.jeans, ITEM_IDS.chinos, ITEM_IDS.loafers] };
    const { valid, rejected } = checkRankedOutfits([noShoes, twoBottoms], known);
    expect(valid).toHaveLength(0);
    expect(rejected.map((r) => r.problem)).toEqual([
      "Needs exactly one pair of shoes",
      "Needs one top and one bottom, or one dress or jumpsuit",
    ]);
  });
});
