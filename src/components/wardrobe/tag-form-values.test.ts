import { describe, expect, it } from "vitest";
import type { ItemTags } from "@/contracts";
import {
  EMPTY_TAG_VALUES,
  parseTagValues,
  tagsWereEdited,
  toggleColour,
  toggleValue,
  valuesFromTags,
  withCategory,
} from "./tag-form-values";

const SHIRT: ItemTags = {
  category: "top",
  subcategory: "shirt",
  colours: ["navy", "white"],
  pattern: "stripe",
  formality: 2,
  seasons: ["spring", "summer"],
  warmth: "light",
  occasions: ["casual", "smart_casual"],
  fabric: "linen",
  description: "Navy and white striped linen shirt",
};

describe("valuesFromTags", () => {
  it("copies suggested tags into the form, with a null fabric as empty text", () => {
    const values = valuesFromTags({ ...SHIRT, fabric: null });
    expect(values).toMatchObject({ category: "top", subcategory: "shirt", colours: ["navy", "white"], fabric: "" });
  });

  it("gives an empty form when tagging failed", () => {
    expect(valuesFromTags(null)).toEqual(EMPTY_TAG_VALUES);
  });

  it("doesn't share arrays with the tags it came from", () => {
    const values = valuesFromTags(SHIRT);
    values.colours.push("red");
    expect(SHIRT.colours).toEqual(["navy", "white"]);
  });
});

describe("withCategory", () => {
  it("clears a subcategory that doesn't belong to the new category", () => {
    expect(withCategory(valuesFromTags(SHIRT), "bottom")).toMatchObject({ category: "bottom", subcategory: "" });
  });

  it("keeps the subcategory when the category doesn't change", () => {
    expect(withCategory(valuesFromTags(SHIRT), "top")).toMatchObject({ category: "top", subcategory: "shirt" });
  });
});

describe("toggleValue and toggleColour", () => {
  it("adds in the order chosen and removes on a second tap", () => {
    expect(toggleValue(["a"], "b")).toEqual(["a", "b"]);
    expect(toggleValue(["a", "b"], "a")).toEqual(["b"]);
  });

  it("allows at most three colours, the first being the main one", () => {
    const three = toggleColour(toggleColour(toggleColour([], "red"), "navy"), "white");
    expect(three).toEqual(["red", "navy", "white"]);
    expect(toggleColour(three, "black")).toEqual(["red", "navy", "white"]);
    expect(toggleColour(three, "red")).toEqual(["navy", "white"]);
  });
});

describe("parseTagValues", () => {
  it("accepts a complete set of tags", () => {
    const result = parseTagValues(valuesFromTags(SHIRT));
    expect(result).toEqual({ ok: true, tags: SHIRT });
  });

  it("reads a blank fabric as null", () => {
    const result = parseTagValues({ ...valuesFromTags(SHIRT), fabric: "   " });
    expect(result.ok && result.tags.fabric).toBeNull();
  });

  it("gives one plain-English message per missing field for an empty form", () => {
    const result = parseTagValues(EMPTY_TAG_VALUES);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(Object.keys(result.errors).sort()).toEqual(
      ["category", "colours", "description", "formality", "occasions", "pattern", "seasons", "subcategory", "warmth"].sort(),
    );
    expect(result.errors.category).toBe("Choose a category");
    expect(result.errors.description).toBe("Add a short description");
  });

  it("rejects a subcategory from another category", () => {
    const result = parseTagValues({ ...valuesFromTags(SHIRT), subcategory: "jeans" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.subcategory).toBe("Choose a type that matches the category");
  });

  it("rejects a description over 120 characters with the schema's own message", () => {
    const result = parseTagValues({ ...valuesFromTags(SHIRT), description: "x".repeat(121) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.description).toMatch(/120 characters/);
  });
});

describe("tagsWereEdited", () => {
  it("is false when the user saved the suggestion as it was", () => {
    expect(tagsWereEdited(SHIRT, structuredClone(SHIRT))).toBe(false);
  });

  it("ignores the order of seasons and occasions", () => {
    expect(tagsWereEdited(SHIRT, { ...SHIRT, seasons: ["summer", "spring"], occasions: ["smart_casual", "casual"] })).toBe(false);
  });

  it("counts a change of main colour as an edit", () => {
    expect(tagsWereEdited(SHIRT, { ...SHIRT, colours: ["white", "navy"] })).toBe(true);
  });

  it("is true for any changed tag", () => {
    expect(tagsWereEdited(SHIRT, { ...SHIRT, formality: 3 })).toBe(true);
  });

  it("is always true when tagging failed and the user filled the tags in", () => {
    expect(tagsWereEdited(null, SHIRT)).toBe(true);
  });
});
