import { describe, expect, it } from "vitest";
import { FORMALITY_OPTIONS, formalityLabel } from "./labels";

describe("formalityLabel", () => {
  it("names each point on the 1-5 scale", () => {
    expect([1, 2, 3, 4, 5].map(formalityLabel)).toEqual([
      "1 · Lounge",
      "2 · Casual",
      "3 · Smart casual",
      "4 · Smart",
      "5 · Formal",
    ]);
  });

  it("shows just the number for anything off the scale, rather than 'undefined'", () => {
    expect(formalityLabel(7)).toBe("7");
  });

  it("is what the tag form's formality chips show", () => {
    expect(FORMALITY_OPTIONS.map((o) => o.label)).toEqual([1, 2, 3, 4, 5].map(formalityLabel));
  });
});
