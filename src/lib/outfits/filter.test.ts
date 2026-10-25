import { describe, expect, it } from "vitest";
import { entry } from "@/test/outfit-helpers";
import { filterItems, fitsFormality, formalityBandFor, seasonMatters } from "./filter";
import { seasonAt } from "./season";

const work = { kind: "preset", presetId: "work" } as const; // band 3–4
const casual = { kind: "preset", presetId: "casual" } as const; // band 1–2
const custom = { kind: "custom", text: "Garden party" } as const;

describe("formality", () => {
  it("keeps items inside the preset's band", () => {
    expect(fitsFormality(entry(1, "top", { formality: 3, occasions: ["casual"] }).tags, work)).toBe(true);
    expect(fitsFormality(entry(1, "top", { formality: 4, occasions: ["casual"] }).tags, work)).toBe(true);
  });

  it("keeps an item one point outside only if it's tagged for the occasion", () => {
    expect(fitsFormality(entry(1, "top", { formality: 2, occasions: ["work"] }).tags, work)).toBe(true);
    expect(fitsFormality(entry(1, "top", { formality: 2, occasions: ["casual"] }).tags, work)).toBe(false);
    expect(fitsFormality(entry(1, "top", { formality: 5, occasions: ["work"] }).tags, work)).toBe(true);
  });

  it("drops anything two or more points outside, even when tagged", () => {
    expect(fitsFormality(entry(1, "top", { formality: 1, occasions: ["work"] }).tags, work)).toBe(false);
    expect(fitsFormality(entry(1, "top", { formality: 5, occasions: ["casual"] }).tags, casual)).toBe(false);
  });

  it("loose mode keeps any item one point outside", () => {
    expect(fitsFormality(entry(1, "top", { formality: 2, occasions: ["casual"] }).tags, work, true)).toBe(true);
    expect(fitsFormality(entry(1, "top", { formality: 1, occasions: ["casual"] }).tags, work, true)).toBe(false);
  });

  it("doesn't filter formality for a custom style (no fixed band)", () => {
    expect(formalityBandFor(custom)).toBeNull();
    for (const formality of [1, 2, 3, 4, 5]) {
      expect(fitsFormality(entry(1, "top", { formality }).tags, custom)).toBe(true);
    }
  });
});

describe("filterItems", () => {
  const summerOnly = entry(1, "top", { seasons: ["summer"] });
  const allYear = entry(2, "top");
  const tooCasual = entry(3, "bottom", { formality: 1, occasions: ["comfy"] });

  it("drops items not worn in the current season", () => {
    expect(filterItems([summerOnly, allYear], { style: work, season: "winter" }).map((i) => i.id)).toEqual([allYear.id]);
    expect(filterItems([summerOnly, allYear], { style: work, season: "summer" })).toHaveLength(2);
  });

  it("can ignore the season", () => {
    expect(filterItems([summerOnly, allYear], { style: work, season: "winter", ignoreSeason: true })).toHaveLength(2);
  });

  it("ignores the season for holiday (warm-weather trips)", () => {
    expect(seasonMatters({ kind: "preset", presetId: "holiday" })).toBe(false);
    const holiday = { kind: "preset", presetId: "holiday" } as const;
    expect(filterItems([summerOnly], { style: holiday, season: "winter" })).toHaveLength(1);
  });

  it("always keeps required items (anchor, kept items)", () => {
    const kept = filterItems([summerOnly, tooCasual], {
      style: work,
      season: "winter",
      keepIds: new Set([summerOnly.id, tooCasual.id]),
    });
    expect(kept).toHaveLength(2);
  });

  it("filters a custom style by season only", () => {
    const formal = entry(4, "dress_jumpsuit", { formality: 5 });
    expect(filterItems([formal, tooCasual, summerOnly], { style: custom, season: "autumn" }).map((i) => i.id)).toEqual([
      formal.id,
      tooCasual.id,
    ]);
  });
});

describe("seasonAt", () => {
  it("uses UK meteorological seasons", () => {
    expect(seasonAt(new Date("2026-03-01T12:00:00Z"))).toBe("spring");
    expect(seasonAt(new Date("2026-07-15T12:00:00Z"))).toBe("summer");
    expect(seasonAt(new Date("2026-10-25T12:00:00Z"))).toBe("autumn");
    expect(seasonAt(new Date("2026-12-01T00:30:00Z"))).toBe("winter");
    expect(seasonAt(new Date("2026-02-28T23:30:00Z"))).toBe("winter");
  });

  it("goes by UK time at a month boundary", () => {
    // 23:30 UTC on 31 May is 00:30 on 1 June in London (BST).
    expect(seasonAt(new Date("2026-05-31T23:30:00Z"))).toBe("summer");
  });
});
