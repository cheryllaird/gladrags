import { describe, expect, it } from "vitest";

import { scrapedText, singleLineText } from "./common";

describe("singleLineText", () => {
  const schema = singleLineText(20);

  it("accepts ordinary text and trims it", () => {
    expect(schema.parse("  warmer please ")).toBe("warmer please");
  });

  it.each([
    ["NUL", "North\u0000gate"],
    ["a C0 control", "bell\u0007"],
    ["a tab inside", "no\theels"],
    ["DEL", "del\u007f"],
  ])("refuses %s", (_name, text) => {
    expect(schema.safeParse(text).success).toBe(false);
  });
});

describe("scrapedText", () => {
  const schema = scrapedText(20);

  it("removes control characters, including NUL, so Postgres can store the text", () => {
    expect(schema.parse("North\u0000gate\u0007 Store\u007f")).toBe("Northgate Store");
  });

  it("still turns tabs and newlines into single spaces", () => {
    expect(schema.parse("Next\t\n  Online")).toBe("Next Online");
  });

  it("reads text made only of control characters as null", () => {
    expect(schema.parse("\u0000\u0001")).toBeNull();
  });
});
