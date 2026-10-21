/**
 * Guards against the SQL CHECK constraints drifting from the Zod contracts.
 * Each vocabulary value must appear quoted in the migrations. (The full
 * migrations are exercised against Postgres by `pnpm db:verify`.)
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ALL_SUBCATEGORIES,
  CATEGORIES,
  COLOURS,
  FEEDBACK_KINDS,
  ITEM_SOURCES,
  OUTFIT_STATUSES,
  PATTERNS,
  PRESET_STYLE_IDS,
  SEASONS,
  SUBCATEGORIES,
  USAGE_EVENT_KINDS,
  WARMTH_LEVELS,
} from "@/contracts";

const dir = join(__dirname, "migrations");
const sql = readdirSync(dir)
  .filter((f) => f.endsWith(".sql"))
  .map((f) => readFileSync(join(dir, f), "utf8"))
  .join("\n");

const vocabularies: Record<string, readonly string[]> = {
  categories: CATEGORIES,
  subcategories: ALL_SUBCATEGORIES,
  colours: COLOURS,
  patterns: PATTERNS,
  seasons: SEASONS,
  warmth: WARMTH_LEVELS,
  occasions: PRESET_STYLE_IDS,
  sources: ITEM_SOURCES,
  "outfit statuses": OUTFIT_STATUSES,
  "feedback kinds": FEEDBACK_KINDS,
  "usage event kinds": USAGE_EVENT_KINDS,
};

describe("migrations match the contracts", () => {
  for (const [name, values] of Object.entries(vocabularies)) {
    it(`include every value of ${name}`, () => {
      const missing = values.filter((v) => !sql.includes(`'${v}'`));
      expect(missing).toEqual([]);
    });
  }

  it("pair each subcategory with its category", () => {
    for (const [category, subs] of Object.entries(SUBCATEGORIES)) {
      const list = subs.map((s) => `'${s}'`).join(", ");
      expect(sql).toContain(`(category = '${category}' and subcategory in (${list}))`);
    }
  });
});
