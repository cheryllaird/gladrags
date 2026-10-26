import { describe, expect, it } from "vitest";
import { NO_FILTERS, filtersFromParams, filtersToQuery, filtersToSearch, hasActiveFilters } from "./wardrobe-filter-values";

describe("filtersFromParams", () => {
  it("reads valid filters from the page URL", () => {
    const filters = filtersFromParams(new URLSearchParams("category=top&colour=navy&occasion=work&q=linen"));
    expect(filters).toEqual({ category: "top", colour: "navy", occasion: "work", q: "linen" });
  });

  it("drops values that aren't in the contract vocabularies", () => {
    const filters = filtersFromParams({ category: "accessory", colour: "dusty_heather", occasion: "party" });
    expect(filters).toEqual(NO_FILTERS);
  });

  it("takes the last of repeated values, as the API does", () => {
    expect(filtersFromParams({ category: ["top", "shoes"] }).category).toBe("shoes");
  });

  it("caps the search at 100 characters", () => {
    expect(filtersFromParams({ q: "x".repeat(150) }).q).toHaveLength(100);
  });
});

describe("filtersToQuery and filtersToSearch", () => {
  it("leaves out empty filters and trims the search", () => {
    const filters = { ...NO_FILTERS, colour: "navy" as const, q: "  linen  " };
    expect(filtersToQuery(filters)).toEqual({ colour: "navy", q: "linen" });
    expect(filtersToSearch(filters)).toBe("?colour=navy&q=linen");
  });

  it("gives an empty query string when nothing is set", () => {
    expect(filtersToQuery({ ...NO_FILTERS, q: "   " })).toEqual({});
    expect(filtersToSearch(NO_FILTERS)).toBe("");
  });
});

describe("hasActiveFilters", () => {
  it("is false for no filters or a blank search", () => {
    expect(hasActiveFilters(NO_FILTERS)).toBe(false);
    expect(hasActiveFilters({ ...NO_FILTERS, q: "  " })).toBe(false);
  });

  it("is true when any filter is set", () => {
    expect(hasActiveFilters({ ...NO_FILTERS, occasion: "work" })).toBe(true);
  });
});
