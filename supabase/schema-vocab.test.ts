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
  DEFAULT_FAVOURITE_SHOP_IDS,
  EMAIL_IMPORT_ERRORS,
  EMAIL_IMPORT_STATUSES,
  FEEDBACK_KINDS,
  MODEL_PRESET_IDS,
  PREVIEW_FAILED_REASONS,
  PREVIEW_SKIPPED_REASONS,
  ITEM_SOURCES,
  OUTFIT_STATUSES,
  PATTERNS,
  PRESET_STYLE_IDS,
  SEASONS,
  SHOP_IDS,
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
  "shop IDs": SHOP_IDS,
  "email import statuses": EMAIL_IMPORT_STATUSES,
  "email import errors": EMAIL_IMPORT_ERRORS,
  "model preset IDs": MODEL_PRESET_IDS,
  "preview failure reasons": PREVIEW_FAILED_REASONS,
  "preview skipped reasons": PREVIEW_SKIPPED_REASONS,
};

describe("migrations match the contracts", () => {
  for (const [name, values] of Object.entries(vocabularies)) {
    it(`include every value of ${name}`, () => {
      const missing = values.filter((v) => !sql.includes(`'${v}'`));
      expect(missing).toEqual([]);
    });
  }

  it("default the favourite shops to the contract's defaults", () => {
    const list = DEFAULT_FAVOURITE_SHOP_IDS.map((id) => `'${id}'`).join(", ");
    expect(sql).toContain(`favourite_shop_ids text[] not null default array[${list}]::text[]`);
  });

  it("list exactly the contract's model presets in is_model_preset_id (round 2)", () => {
    const body = /function public\.is_model_preset_id[\s\S]*?\$\$;/.exec(sql)?.[0] ?? "";
    const listed = [...body.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(listed.sort()).toEqual([...MODEL_PRESET_IDS].sort());
  });

  it("pair each subcategory with its category", () => {
    for (const [category, subs] of Object.entries(SUBCATEGORIES)) {
      const list = subs.map((s) => `'${s}'`).join(", ");
      expect(sql).toContain(`(category = '${category}' and subcategory in (${list}))`);
    }
  });
});
