import { describe, expect, it } from "vitest";
import { startOfDay, startOfMonth, startOfNextDay, startOfNextMonth } from "./time";

const UK = "Europe/London";

describe("UK day and month boundaries", () => {
  it("in winter (GMT) midnight is 00:00 UTC", () => {
    const now = new Date("2026-01-15T15:30:00Z");
    expect(startOfDay(now, UK).toISOString()).toBe("2026-01-15T00:00:00.000Z");
    expect(startOfNextDay(now, UK).toISOString()).toBe("2026-01-16T00:00:00.000Z");
  });

  it("in summer (BST) midnight is 23:00 UTC the day before", () => {
    const now = new Date("2026-07-15T10:00:00Z");
    expect(startOfDay(now, UK).toISOString()).toBe("2026-07-14T23:00:00.000Z");
    expect(startOfNextDay(now, UK).toISOString()).toBe("2026-07-15T23:00:00.000Z");
  });

  it("just after UK midnight in summer is already the new day", () => {
    const now = new Date("2026-07-14T23:30:00Z"); // 00:30 BST on 15 July
    expect(startOfDay(now, UK).toISOString()).toBe("2026-07-14T23:00:00.000Z");
  });

  it("handles the day the clocks go back", () => {
    const now = new Date("2026-10-25T12:00:00Z"); // clocks went back at 01:00 UTC
    expect(startOfDay(now, UK).toISOString()).toBe("2026-10-24T23:00:00.000Z");
    expect(startOfNextDay(now, UK).toISOString()).toBe("2026-10-26T00:00:00.000Z");
  });

  it("finds the month boundaries, including over a year end", () => {
    expect(startOfMonth(new Date("2026-10-21T12:00:00Z"), UK).toISOString()).toBe("2026-09-30T23:00:00.000Z");
    expect(startOfNextMonth(new Date("2026-10-21T12:00:00Z"), UK).toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(startOfNextMonth(new Date("2026-12-31T12:00:00Z"), UK).toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });
});
