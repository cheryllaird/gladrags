import { describe, expect, it } from "vitest";
import { ALL_SUBCATEGORIES, API_ERROR_CODES, CATEGORIES } from "@/contracts";
import { collageFileName } from "./collage-draw";
import { CATEGORY_LABELS, describeApiError, formatResetTime, styleLabel, subcategoryLabel } from "./copy";

describe("styleLabel", () => {
  it("uses the preset's label", () => {
    expect(styleLabel({ kind: "preset", presetId: "smart_casual" })).toBe("Smart casual");
  });
  it("quotes the user's own words", () => {
    expect(styleLabel({ kind: "custom", text: "first day at a new job" })).toBe("“first day at a new job”");
  });
});

describe("labels", () => {
  it("has wording for every category", () => {
    for (const category of CATEGORIES) expect(CATEGORY_LABELS[category].add).toMatch(/^Add /);
  });
  it("turns every subcategory ID into a friendly label", () => {
    expect(subcategoryLabel("t_shirt")).toBe("T-shirt");
    expect(subcategoryLabel("smart_shoes")).toBe("Smart shoes");
    for (const sub of ALL_SUBCATEGORIES) expect(subcategoryLabel(sub)).toMatch(/^[A-Z][a-z -]+$/);
  });
});

describe("formatResetTime", () => {
  it("shows UK time, including British Summer Time", () => {
    // 23:00 UTC on 20 Oct 2026 is midnight in London (still BST); December is GMT.
    expect(formatResetTime("2026-10-20T23:00:00.000Z")).toBe("Wed 21 Oct, 00:00");
    expect(formatResetTime("2026-12-01T00:00:00.000Z")).toBe("Tue 1 Dec, 00:00");
  });
});

describe("describeApiError", () => {
  it("ai_paused: explains the monthly pause and when it ends", () => {
    const copy = describeApiError({
      code: "ai_paused",
      message: "Paused",
      cap: { kind: "monthly_ai_spend", limit: 500, resetsAt: "2026-11-01T00:00:00.000Z" },
    });
    expect(copy.title).toMatch(/paused/i);
    expect(copy.message).toContain("Sun 1 Nov, 00:00");
    expect(copy.message).toMatch(/saved outfits still work/);
    expect(copy.retryable).toBe(false);
  });

  it("daily_cap_reached: gives the limit and the reset time", () => {
    const copy = describeApiError({
      code: "daily_cap_reached",
      message: "Cap",
      cap: { kind: "outfit_requests_per_day", limit: 25, resetsAt: "2026-10-20T23:00:00.000Z" },
    });
    expect(copy.message).toContain("25 outfit requests");
    expect(copy.message).toContain("Wed 21 Oct, 00:00");
    expect(copy.retryable).toBe(false);
  });

  it("ai_failed: offers to try again", () => {
    expect(describeApiError({ code: "ai_failed", message: "Model failed" })).toMatchObject({ retryable: true });
  });

  it("has a title and message for every error code", () => {
    for (const code of API_ERROR_CODES) {
      const copy = describeApiError({ code, message: "Something" });
      expect(copy.title.length).toBeGreaterThan(0);
      expect(copy.message.length).toBeGreaterThan(0);
    }
  });
});

describe("collageFileName", () => {
  it("makes a safe file name from the outfit name", () => {
    expect(collageFileName("Easy weekend")).toBe("gladrags-easy-weekend.png");
    expect(collageFileName("Navy & tan: smart!")).toBe("gladrags-navy-tan-smart.png");
    expect(collageFileName("!!!")).toBe("gladrags-outfit.png");
  });
});
