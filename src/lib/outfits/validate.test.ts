import { describe, expect, it } from "vitest";
import type { Category } from "@/contracts";
import { uuid } from "@/test/outfit-helpers";
import { describeProblems, validateOutfits } from "./validate";

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
