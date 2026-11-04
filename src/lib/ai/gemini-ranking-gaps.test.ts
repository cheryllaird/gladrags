/**
 * The Gemini ranking provider with gaps (milestone 5), no network: the
 * prompts and JSON schemas for outfits with gap slots, and recorded-style
 * replies played back from src/test/fixtures/gemini-ranking/ (synthetic
 * until real recordings can be made; see the live recorder).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { GenerateContentParameters } from "@google/genai";
import { describe, expect, it } from "vitest";
import {
  CATEGORIES,
  RankingFinalOutputSchema,
  RankingShortlistOutputSchema,
  parseModelOutput,
  type Category,
} from "@/contracts";
import { MOCK_ITEMS } from "@/lib/mocks/fixtures";
import { checkReply, validateOutfits } from "@/lib/outfits/validate";
import {
  IDS,
  NO_SHOES_GAP_RULES,
  NO_SHOES_ITEMS,
  SHOP_ITEMS_GAP_RULES,
  noShoesShortlistInput,
  shopItemsFinalInput,
  workShortlistInput,
} from "@/test/fixtures/ranking-inputs";
import { GeminiRankingProvider, SUPPORTED_SCHEMA_KEYWORDS, buildFinalPickPrompt, buildShortlistPrompt, outputSchema, type GeminiContentGenerator } from "./gemini-ranking";

const FIXTURES = fileURLToPath(new URL("../../test/fixtures/gemini-ranking/", import.meta.url));
const recordedText = (name: string) => (JSON.parse(readFileSync(`${FIXTURES}${name}.json`, "utf8")) as { text: string }).text;

function playback(text: string) {
  const requests: GenerateContentParameters[] = [];
  const generator: GeminiContentGenerator = {
    async generateContent(params) {
      requests.push(params);
      return { text };
    },
  };
  return { provider: new GeminiRankingProvider(generator, "test-model"), requests };
}

const userData = (params: { contents: unknown }) =>
  JSON.parse((params.contents as { parts: { text?: string }[] }[])[0]!.parts[0]!.text!) as Record<string, unknown>;
const categoryOf = (id: string) => MOCK_ITEMS.find((i) => i.id === id)!.tags.category;
const known = (ids: readonly string[]) => new Map<string, Category>(ids.map((id) => [id, categoryOf(id)]));

/** Every JSON-schema keyword used anywhere in a schema. */
function keywords(schema: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(schema)) schema.forEach((s) => keywords(s, found));
  else if (schema && typeof schema === "object") {
    for (const [key, value] of Object.entries(schema)) {
      found.add(key);
      if (key === "properties") Object.values(value as object).forEach((v) => keywords(v, found));
      else if (typeof value === "object") keywords(value, found);
    }
  }
  return found;
}

describe("pass 1 prompt with gaps", () => {
  const input = noShoesShortlistInput();
  const { params, refs } = buildShortlistPrompt(input);
  const system = String(params.config!.systemInstruction);
  const data = JSON.parse((params.contents as { parts: { text: string }[] }[])[0]!.parts[0]!.text);

  it("lists each candidate with its owned item refs and its gap slots", () => {
    expect(data.candidates[0]).toEqual({ items: refs.refsOf([IDS.tshirt, IDS.jeans]), gaps: ["shoes"] });
    expect(data.candidates[3]).toEqual({ items: [refs.ref(IDS.dress)], gaps: ["shoes"] });
    expect(data.includeShopItems).toBe(false);
  });

  it("tells the model how to describe gaps, to keep the listed slots, and to prefer complete outfits", () => {
    expect(system).toContain('"gaps"');
    expect(system).toContain("Never add a gap the outfit doesn't list, and never leave one out");
    expect(system).toContain("Prefer complete outfits from the wardrobe");
    expect(system).toContain("at most 120 characters");
    expect(system).not.toContain("includeShopItems");
  });

  it("lets the model describe gaps only in the offered slots, with palette colours, using supported keywords only", () => {
    const schema = params.config!.responseJsonSchema as {
      properties: { outfits: { items: { properties: { itemIds: { minItems: number }; gaps: { items: { properties: Record<string, { enum?: string[]; items?: { enum: string[] } }> } } } } } };
    };
    const outfit = schema.properties.outfits.items.properties;
    expect(outfit.itemIds.minItems).toBe(1);
    expect(outfit.gaps.items.properties.category!.enum).toEqual(["shoes"]);
    expect(outfit.gaps.items.properties.colours!.items!.enum).toContain("navy");
    expect(outfit.gaps.items.properties.colours!.items!.enum).not.toContain("dusty heather");
    for (const keyword of keywords(schema)) expect(SUPPORTED_SCHEMA_KEYWORDS, keyword).toContain(keyword);
  });

  it("keeps the old prompt and schema exactly when no candidate has gaps", () => {
    const plain = buildShortlistPrompt(workShortlistInput());
    const plainData = JSON.parse((plain.params.contents as { parts: { text: string }[] }[])[0]!.parts[0]!.text);
    expect(Array.isArray(plainData.candidates[0])).toBe(true);
    expect(plainData).not.toHaveProperty("includeShopItems");
    expect(String(plain.params.config!.systemInstruction)).not.toContain('"gaps"');
    expect(JSON.stringify(plain.params.config!.responseJsonSchema)).not.toContain("gaps");
    const schema = outputSchema(["I1"], 8, false);
    expect(schema.properties.outfits.items).toMatchObject({ properties: { itemIds: { minItems: 2, maxItems: 4 } } });
  });
});

describe("pass 1 replies with gaps (recorded fixtures)", () => {
  const input = noShoesShortlistInput();
  const rules = {
    known: known(NO_SHOES_ITEMS.map((i) => i.id)),
    allowedOutfits: input.candidates,
    gaps: NO_SHOES_GAP_RULES,
  };

  it("maps a good reply back to item IDs, with every outfit's shoes gap described", async () => {
    const { provider } = playback(recordedText("no-shoes-shortlist"));
    const parsed = parseModelOutput(RankingShortlistOutputSchema, (await provider.shortlist(input)).raw);
    if (!parsed.success) throw new Error(parsed.error);
    const check = validateOutfits(parsed.data.outfits, rules);
    expect(check.rejected).toEqual([]);
    expect(check.valid).toHaveLength(6);
    expect(check.valid[0]).toEqual({
      itemIds: [IDS.tshirt, IDS.jeans],
      gaps: [{ category: "shoes", subcategory: "trainers", colours: ["white"], description: "White leather trainers" }],
    });
    expect(check.valid[2]!.itemIds).toEqual([IDS.dress]);
  });

  it("drops every bad outfit in a bad reply (made-up ref, broken slot rules, bad gap text) and keeps the good one", async () => {
    const { provider } = playback(recordedText("no-shoes-shortlist-bad"));
    const raw = (await provider.shortlist(input)).raw as { outfits: unknown[] };
    const schema = RankingShortlistOutputSchema.shape.outfits.element;
    const reply = checkReply(raw.outfits, schema, rules, 3);
    expect(reply.valid.map((o) => o.itemIds)).toEqual([[IDS.tshirt, IDS.jeans]]);
    const problem = reply.problem!;
    expect(problem).toContain("Outfit 2: ✖ Invalid UUID"); // made-up ref I99 stays unmapped, so it isn't an item ID
    expect(problem).toContain("Needs exactly one pair of shoes"); // shoes gap left out
    expect(problem).toContain("Shop-item gap(s) not allowed"); // outerwear, and a bottom the wardrobe could fill
    expect(problem).toMatch(/Outfit 5: ✖ Invalid option.*gaps\[0\]\.colours\[0\]/); // "dusty heather"
    expect(problem).toContain("Mentions an item ref"); // "I1" in a description
    expect(problem).toContain("not a shoes subcategory"); // "jeans" shoes
    expect(problem).toContain("Two gaps can't fill the same slot");
  });
});

describe("pass 2 with shop items (recorded fixtures)", () => {
  const input = shopItemsFinalInput();
  const rules = {
    known: known(input.shortlist.flatMap((o) => o.itemIds)),
    allowedOutfits: input.shortlist.map((o) => ({ itemIds: o.itemIds, gaps: o.gaps.map((g) => g.category) })),
    gaps: SHOP_ITEMS_GAP_RULES,
  };

  it("shows each shortlisted outfit's gap slots, with pass 1's suggestion where there was one", () => {
    const { params, refs } = buildFinalPickPrompt(input);
    const data = userData(params);
    expect(data.includeShopItems).toBe(true);
    expect((data.shortlist as unknown[])[1]).toEqual({
      items: refs.refsOf([IDS.shirt, IDS.chinos]),
      gaps: [{ category: "shoes", suggestion: { category: "shoes", subcategory: "loafers", colours: ["burgundy"], description: "Burgundy suede loafers" } }],
    });
    expect((data.shortlist as unknown[])[2]).toEqual({ items: refs.refsOf([IDS.dress, IDS.loafers]), gaps: [{ category: "outerwear" }] });
    const system = String(params.config!.systemInstruction);
    expect(system).toContain("asked to include items from their shops");
    expect(system).toContain("include at least one outfit with a gap");
    expect(system).toContain('"suggestion"');
    const schema = JSON.stringify(params.config!.responseJsonSchema);
    expect(schema).toContain('"enum":["shoes","outerwear"]');
    for (const keyword of keywords(params.config!.responseJsonSchema)) expect(SUPPORTED_SCHEMA_KEYWORDS, keyword).toContain(keyword);
  });

  it("reads a fenced reply: named outfits, at most one shop-item gap each", async () => {
    const { provider } = playback(recordedText("shop-items-final"));
    const parsed = parseModelOutput(RankingFinalOutputSchema, (await provider.pickFinal(input)).raw);
    if (!parsed.success) throw new Error(parsed.error);
    const check = validateOutfits(parsed.data.outfits, rules);
    expect(check.rejected).toEqual([]);
    expect(check.valid.map((o) => o.gaps?.map((g) => g.category) ?? [])).toEqual([["shoes"], [], ["outerwear"]]);
    expect(check.valid[2]!.gaps![0]!.description).toBe("Cream cropped tweed jacket");
  });

  it("refuses two shop items in one outfit, a dropped gap and an outfit that wasn't shortlisted", async () => {
    const { provider } = playback(recordedText("shop-items-final-bad"));
    const raw = (await provider.pickFinal(input)).raw as { outfits: unknown[] };
    const reply = checkReply(raw.outfits, RankingFinalOutputSchema.shape.outfits.element, rules, 3);
    expect(reply.valid.map((o) => o.name)).toEqual(["Easy smart"]);
    expect(reply.problem).toContain("At most 1 shop-item gap");
    expect(reply.problem).toContain("Isn't one of the outfits offered");
  });
});

describe("pass 2 sends tags", () => {
  it("lists every shortlisted item's tags once, by ref, alongside the photos", () => {
    const input = shopItemsFinalInput();
    const { params, refs } = buildFinalPickPrompt(input);
    const data = userData(params) as { items: { ref: string; description: string }[] };
    expect(data.items.map((i) => i.ref)).toEqual(refs.refsOf([IDS.shirt, IDS.chinos, IDS.loafers, IDS.dress, IDS.tshirt, IDS.jeans, IDS.trainers]));
    expect(data.items[0]!.description).toBe(MOCK_ITEMS.find((i) => i.id === IDS.shirt)!.tags.description);
  });
});

describe("refinement of an outfit with gaps", () => {
  it("sends the previous outfit's gaps with it", () => {
    const input = noShoesShortlistInput();
    input.refinement = {
      previousItemIds: [IDS.tshirt, IDS.jeans],
      previousGaps: [{ category: "shoes", subcategory: "trainers", colours: ["white"], description: "White leather trainers" }],
      feedback: { kind: "guidance", text: "smarter shoes" },
    };
    const data = userData(buildShortlistPrompt(input).params);
    expect(data.refinement).toMatchObject({
      kind: "guidance",
      previousGaps: [{ category: "shoes", subcategory: "trainers", colours: ["white"], description: "White leather trainers" }],
      guidance: "smarter shoes",
    });
  });
});

it("every category the model may name for a gap is a real category", () => {
  const { params } = buildShortlistPrompt(noShoesShortlistInput());
  const categories = (params.config!.responseJsonSchema as { properties: { outfits: { items: { properties: { gaps: { items: { properties: { category: { enum: string[] } } } } } } } } })
    .properties.outfits.items.properties.gaps.items.properties.category.enum;
  for (const c of categories) expect(CATEGORIES).toContain(c);
});
