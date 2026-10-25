import { describe, expect, it } from "vitest";
import { RankingFinalOutputSchema, type Category } from "@/contracts";
import { uuid } from "@/test/outfit-helpers";
import { checkReply, parseEachOutfit, validateOutfits } from "./validate";

const describeProblems = (check: { rejected: { problem: string }[] }) =>
  check.rejected.length ? check.rejected.map((r) => r.problem).join("; ") : null;

const TOP = uuid(1);
const BOTTOM = uuid(2);
const SHOES = uuid(3);
const COAT = uuid(4);
const DRESS = uuid(5);
const SHOES_2 = uuid(6);
const STRANGER = uuid(999);

const known = new Map<string, Category>([
  [TOP, "top"],
  [BOTTOM, "bottom"],
  [SHOES, "shoes"],
  [COAT, "outerwear"],
  [DRESS, "dress_jumpsuit"],
  [SHOES_2, "shoes"],
]);

const o = (...itemIds: string[]) => ({ itemIds });

describe("validateOutfits", () => {
  it("accepts wearable outfits made of known items", () => {
    const check = validateOutfits([o(TOP, BOTTOM, SHOES), o(DRESS, SHOES, COAT)], { known });
    expect(check.rejected).toEqual([]);
    expect(check.valid).toHaveLength(2);
    expect(describeProblems(check)).toBeNull();
  });

  it("rejects an item ID that isn't in the wardrobe", () => {
    const check = validateOutfits([o(TOP, BOTTOM, STRANGER)], { known });
    expect(check.valid).toEqual([]);
    expect(describeProblems(check)).toContain("Unknown item ID");
  });

  it("rejects broken composition", () => {
    const check = validateOutfits([o(TOP, BOTTOM), o(TOP, DRESS, SHOES), o(DRESS, SHOES, SHOES_2)], { known });
    expect(check.valid).toEqual([]);
    expect(check.rejected).toHaveLength(3);
  });

  it("rejects an outfit without the anchor", () => {
    const check = validateOutfits([o(TOP, BOTTOM, SHOES), o(TOP, BOTTOM, SHOES, COAT)], { known, anchorItemId: COAT });
    expect(check.valid).toEqual([o(TOP, BOTTOM, SHOES, COAT)]);
    expect(describeProblems(check)).toContain("anchor");
  });

  it("rejects an outfit missing another required item", () => {
    const check = validateOutfits([o(TOP, BOTTOM, SHOES_2), o(DRESS, SHOES_2)], { known, requiredIds: [TOP, BOTTOM] });
    expect(check.valid).toEqual([o(TOP, BOTTOM, SHOES_2)]);
    expect(describeProblems(check)).toContain("required item");
  });

  it("rejects an excluded outfit in any order, and repeats within one reply", () => {
    const check = validateOutfits([o(SHOES, BOTTOM, TOP), o(DRESS, SHOES), o(SHOES, DRESS)], {
      known,
      excludeOutfits: [[TOP, BOTTOM, SHOES]],
    });
    expect(check.valid).toEqual([o(DRESS, SHOES)]);
    expect(check.rejected.map((r) => r.problem)).toEqual([
      "Repeats an outfit that was rejected or is being refined",
      "Repeats an earlier outfit in the same reply",
    ]);
  });

  it("treats items outside `known` as unknown even if they're real wardrobe items", () => {
    // Pass 2 only knows the shortlisted items.
    const shortlistOnly = new Map<string, Category>([
      [DRESS, "dress_jumpsuit"],
      [SHOES, "shoes"],
    ]);
    expect(validateOutfits([o(DRESS, SHOES_2)], { known: shortlistOnly }).valid).toEqual([]);
  });
});

describe("offered outfits and item refs", () => {
  it("rejects an outfit that isn't one of those offered, in any order", () => {
    const check = validateOutfits([o(SHOES, TOP, BOTTOM), o(DRESS, SHOES)], { known, allowedOutfits: [[TOP, BOTTOM, SHOES]] });
    expect(check.valid).toEqual([o(SHOES, TOP, BOTTOM)]);
    expect(describeProblems(check)).toBe("Isn't one of the outfits offered");
  });

  it("rejects a name or reason that shows an item ref", () => {
    const named = (name: string, reason: string) => ({ itemIds: [TOP, BOTTOM, SHOES], name, reason });
    expect(validateOutfits([named("I3 look", "Works")], { known }).valid).toEqual([]);
    expect(validateOutfits([named("Easy", "I3 and I7 keep it smart")], { known }).valid).toEqual([]);
    expect(validateOutfits([named("Iconic", "In 2 colours, with I-beam stripes")], { known }).valid).toHaveLength(1);
  });
});

describe("checkReply: each outfit judged on its own", () => {
  const schema = RankingFinalOutputSchema.shape.outfits.element;
  const good = { itemIds: [TOP, BOTTOM, SHOES], name: "Easy", reason: "Works" };
  const good2 = { itemIds: [DRESS, SHOES], name: "Dress", reason: "Works" };

  it("keeps the good outfits when others fail the schema", () => {
    const tooLong = { itemIds: [DRESS, SHOES_2], name: "x".repeat(41), reason: "Too long" };
    const twice = { itemIds: [TOP, TOP, SHOES], name: "Twice", reason: "Same top" };
    const notIds = { itemIds: ["I1", "I999"], name: "Refs", reason: "Not mapped" };
    const { parsed, problems } = parseEachOutfit([good, tooLong, twice, notIds, "nonsense"], schema);
    expect(parsed).toEqual([good]);
    expect(problems).toHaveLength(4);
    expect(problems[0]).toMatch(/^Outfit 2:/);
  });

  it("asks for a retry only when fewer than `enough` are valid", () => {
    const bad = { itemIds: [TOP, STRANGER, SHOES], name: "Bad", reason: "Unknown item" };
    expect(checkReply([good, bad], schema, { known }, 2)).toMatchObject({ valid: [good], problem: expect.stringContaining("Unknown") });
    expect(checkReply([good, good2, bad], schema, { known }, 2)).toEqual({ valid: [good, good2], problem: null });
  });

  it("accepts a reply with no problems even if it has fewer than `enough`", () => {
    expect(checkReply([good], schema, { known }, 3)).toEqual({ valid: [good], problem: null });
  });
});
