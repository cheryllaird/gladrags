/**
 * Round 2 contracts: model presets, the preview on an outfit, the cache key
 * and the checks on generated images (including recorded bad replies).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PREVIEW_REPLY_BLOCKED,
  PREVIEW_REPLY_EMPTY,
  PREVIEW_REPLY_GOOD,
  PREVIEW_REPLY_NOT_AN_IMAGE,
  PREVIEW_REPLY_SQUARE,
} from "@/lib/ai/fixtures/preview-fixtures";
import type { FakeImageReply } from "@/lib/ai/fakes";
import { inspectGeneratedImage } from "@/lib/images/preview-check";
import {
  BUILDS_BY_GENDER,
  DEFAULT_MODEL_PRESET_ID,
  MODEL_PRESETS,
  MODEL_PRESET_IDS,
  ModelPresetIdSchema,
  NO_PREVIEW,
  OutfitPreviewSchema,
  OutfitSchema,
  PREVIEW_OUTPUT_MAX_BYTES,
  PreviewRequestQuerySchema,
  SHOPS,
  shopImageUrlAllowed,
  UpdateSettingsRequestSchema,
  UserSettingsSchema,
  checkGeneratedPreviewImage,
  previewCacheKey,
  previewCacheKeySource,
  type GeneratedImageFacts,
  type PreviewLook,
} from "@/contracts";
import { MOCK_ITEMS } from "@/lib/mocks/fixtures";

describe("model presets", () => {
  it("are 2 figures x 4 builds x 3 skin tones, with unique ids", () => {
    expect(MODEL_PRESETS).toHaveLength(24);
    expect(new Set(MODEL_PRESET_IDS).size).toBe(24);
    for (const gender of ["women", "men"] as const) {
      const builds = new Set(MODEL_PRESETS.filter((p) => p.gender === gender).map((p) => p.build));
      expect([...builds].sort()).toEqual([...BUILDS_BY_GENDER[gender]].sort());
    }
  });

  it("each has a label, a .webp picture under /presets that exists, and a matching id", () => {
    for (const preset of MODEL_PRESETS) {
      expect(preset.id).toBe(`${preset.gender}_${preset.build}_${preset.skinTone}`);
      expect(preset.imagePath).toBe(`/presets/${preset.id}.webp`);
      expect(preset.label.length).toBeGreaterThan(10);
      expect(existsSync(join(process.cwd(), "public", preset.imagePath))).toBe(true);
    }
  });

  it("the default is a preset; curvy is women's only and broad men's only", () => {
    expect(ModelPresetIdSchema.safeParse(DEFAULT_MODEL_PRESET_ID).success).toBe(true);
    expect(ModelPresetIdSchema.safeParse("men_curvy_light").success).toBe(false);
    expect(ModelPresetIdSchema.safeParse("women_broad_light").success).toBe(false);
    expect(ModelPresetIdSchema.safeParse("").success).toBe(false);
  });
});

describe("settings with a model preset", () => {
  it("GET carries the preset or null (missing reads as null)", () => {
    expect(UserSettingsSchema.parse({ favouriteShopIds: ["next"], forwardingAddress: null }).modelPresetId).toBeNull();
    expect(UserSettingsSchema.safeParse({ modelPresetId: "women_plus_deep", favouriteShopIds: ["next"], forwardingAddress: null }).success).toBe(true);
    // An unknown stored preset (one removed or renamed later) reads as null, "not picked yet":
    // the user is asked again instead of the whole settings read failing.
    expect(UserSettingsSchema.parse({ modelPresetId: "robot", favouriteShopIds: ["next"], forwardingAddress: null }).modelPresetId).toBeNull();
  });

  it("setting a preset stays strict", () => {
    expect(UpdateSettingsRequestSchema.safeParse({ modelPresetId: "robot" }).success).toBe(false);
  });

  it("PUT takes shops, a preset, or both; never neither, never a null preset", () => {
    expect(UpdateSettingsRequestSchema.safeParse({ modelPresetId: "men_slim_deep" }).success).toBe(true);
    expect(UpdateSettingsRequestSchema.safeParse({ favouriteShopIds: ["zara"] }).success).toBe(true);
    expect(UpdateSettingsRequestSchema.safeParse({ favouriteShopIds: ["zara"], modelPresetId: "men_slim_deep" }).success).toBe(true);
    expect(UpdateSettingsRequestSchema.safeParse({}).success).toBe(false);
    expect(UpdateSettingsRequestSchema.safeParse({ modelPresetId: null }).success).toBe(false);
  });
});

describe("the preview on an outfit", () => {
  const ready = { status: "ready", imageUrl: "https://x.supabase.co/sign/p.webp", failureReason: null, presetId: "women_slim_light", suggestedSlots: ["shoes"], outdated: false };

  it("accepts each status with its matching fields", () => {
    expect(OutfitPreviewSchema.safeParse(NO_PREVIEW).success).toBe(true);
    expect(OutfitPreviewSchema.safeParse(ready).success).toBe(true);
    expect(OutfitPreviewSchema.safeParse({ ...ready, outdated: true }).success).toBe(true);
    expect(OutfitPreviewSchema.safeParse({ ...ready, status: "pending", imageUrl: null }).success).toBe(true);
    expect(OutfitPreviewSchema.safeParse({ ...ready, status: "failed", imageUrl: null, failureReason: "blocked" }).success).toBe(true);
    expect(OutfitPreviewSchema.safeParse({ ...ready, status: "skipped", imageUrl: null, failureReason: "ai_paused" }).success).toBe(true);
  });

  it("refuses mismatched fields", () => {
    expect(OutfitPreviewSchema.safeParse({ ...ready, imageUrl: null }).success).toBe(false);
    expect(OutfitPreviewSchema.safeParse({ ...ready, status: "pending" }).success).toBe(false);
    expect(OutfitPreviewSchema.safeParse({ ...ready, status: "failed", imageUrl: null, failureReason: null }).success).toBe(false);
    expect(OutfitPreviewSchema.safeParse({ ...ready, status: "failed", imageUrl: null, failureReason: "daily_cap_reached" }).success).toBe(false);
    expect(OutfitPreviewSchema.safeParse({ ...ready, status: "skipped", imageUrl: null, failureReason: "ai_failed" }).success).toBe(false);
    expect(OutfitPreviewSchema.safeParse({ ...ready, failureReason: "ai_failed" }).success).toBe(false);
    expect(OutfitPreviewSchema.safeParse({ ...ready, suggestedSlots: ["hat"] }).success).toBe(false);
    expect(OutfitPreviewSchema.safeParse({ ...ready, presetId: "robot" }).success).toBe(false);
  });

  it("an outfit without one (saved before round 2) reads as none", () => {
    const [top, , , bottom] = MOCK_ITEMS;
    const outfit = OutfitSchema.parse({
      id: "2b000000-0000-4000-8000-000000000001",
      request: { style: { kind: "preset", presetId: "casual" }, guidance: null, anchorItemId: null },
      name: "Easy",
      reason: "Calm colours",
      itemIds: [top!.id, bottom!.id],
      items: [top, bottom],
      gaps: [{ category: "shoes", subcategory: null, colours: ["white"], description: "White trainers" }],
      status: "suggested",
      parentOutfitId: null,
      createdAt: "2026-11-13T10:00:00.000Z",
    });
    expect(outfit.preview).toEqual(NO_PREVIEW);
  });

  it("refresh is a query flag, false by default", () => {
    expect(PreviewRequestQuerySchema.parse({}).refresh).toBe(false);
    expect(PreviewRequestQuerySchema.parse({ refresh: "true" }).refresh).toBe(true);
    expect(PreviewRequestQuerySchema.safeParse({ refresh: "maybe" }).success).toBe(false);
  });
});

describe("the preview cache key", () => {
  const look: PreviewLook = {
    presetId: "women_average_medium",
    itemIds: ["1a000000-0000-4000-8000-000000000001", "1a000000-0000-4000-8000-000000000004"],
    gaps: [
      { category: "shoes", subcategory: "trainers", colours: ["white"], description: "White leather trainers", shopProduct: null },
      { category: "outerwear", subcategory: null, colours: ["navy"], description: "Navy jacket" },
    ],
  };

  it("is a 64-digit hex hash, the same for the same look in any order", async () => {
    const key = await previewCacheKey(look);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    const reordered = { ...look, itemIds: [...look.itemIds].reverse(), gaps: [...look.gaps].reverse() };
    expect(await previewCacheKey(reordered)).toBe(key);
  });

  it("changes with the preset, the items, a gap's description, colours or subcategory, and the picked product", async () => {
    const key = await previewCacheKey(look);
    const variants: PreviewLook[] = [
      { ...look, presetId: "men_average_medium" },
      { ...look, itemIds: [look.itemIds[0]!] },
      { ...look, gaps: [{ ...look.gaps[0]!, description: "White canvas trainers" }, look.gaps[1]!] },
      { ...look, gaps: [{ ...look.gaps[0]!, colours: ["white", "navy"] }, look.gaps[1]!] },
      { ...look, gaps: [{ ...look.gaps[0]!, subcategory: null }, look.gaps[1]!] },
      { ...look, gaps: [{ ...look.gaps[0]!, shopProduct: { url: "https://www.next.co.uk/p/1" } }, look.gaps[1]!] },
      { ...look, gaps: [look.gaps[0]!] },
    ];
    const keys = await Promise.all(variants.map(previewCacheKey));
    expect(new Set([key, ...keys]).size).toBe(variants.length + 1);
  });

  it("ignores what doesn't change the picture (shop results, search time)", async () => {
    const withResults = {
      ...look,
      gaps: look.gaps.map((g) => ({ ...g, shopResults: [{ url: "https://www.next.co.uk/p/9" }], searchedAt: "2026-11-13T10:00:00Z" })),
    };
    expect(await previewCacheKey(withResults)).toBe(await previewCacheKey(look));
    expect(previewCacheKeySource(look)).toContain('"v":1');
  });
});

/**
 * What the preview route does with a reply: sniff and fully decode it
 * (inspectGeneratedImage; a header read with metadata() isn't enough),
 * then check.
 */
async function factsOf(reply: FakeImageReply): Promise<GeneratedImageFacts | "no image"> {
  if (reply === "throw" || !("image" in reply)) return "no image";
  return inspectGeneratedImage(reply.image.data);
}

describe("checks on a generated image", () => {
  it("accept the recorded good reply (832 x 1248 PNG)", async () => {
    const facts = await factsOf(PREVIEW_REPLY_GOOD);
    expect(facts).not.toBe("no image");
    expect(checkGeneratedPreviewImage(facts as GeneratedImageFacts)).toEqual({ ok: true });
  });

  it("refuse a square image (not a full-length portrait)", async () => {
    const result = checkGeneratedPreviewImage((await factsOf(PREVIEW_REPLY_SQUARE)) as GeneratedImageFacts);
    expect(result.ok).toBe(false);
  });

  it("refuse bytes that aren't an image, whatever type the model declared", async () => {
    const result = checkGeneratedPreviewImage((await factsOf(PREVIEW_REPLY_NOT_AN_IMAGE)) as GeneratedImageFacts);
    expect(result).toMatchObject({ ok: false });
  });

  it("refuse a truncated image whose header still reports the full size (a full decode catches it)", async () => {
    const good = PREVIEW_REPLY_GOOD as { image: { data: Uint8Array } };
    const half = good.image.data.slice(0, Math.floor(good.image.data.byteLength / 2));
    const facts = await inspectGeneratedImage(half);
    expect(facts.dimensions).toBeNull();
    expect(checkGeneratedPreviewImage(facts).ok).toBe(false);
  });

  it("refuse a NaN or negative byte length", () => {
    for (const byteLength of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      expect(checkGeneratedPreviewImage({ mimeType: "image/png", byteLength, dimensions: { width: 832, height: 1248 } }).ok).toBe(false);
    }
  });

  it("a refusal or an empty reply has no image to check", async () => {
    expect(await factsOf(PREVIEW_REPLY_BLOCKED)).toBe("no image");
    expect(await factsOf(PREVIEW_REPLY_EMPTY)).toBe("no image");
  });

  it.each([
    ["empty", { mimeType: "image/png", byteLength: 0, dimensions: { width: 832, height: 1248 } }],
    ["too big", { mimeType: "image/png", byteLength: PREVIEW_OUTPUT_MAX_BYTES + 1, dimensions: { width: 832, height: 1248 } }],
    ["a GIF", { mimeType: "image/gif", byteLength: 1000, dimensions: { width: 832, height: 1248 } }],
    ["an unknown type", { mimeType: null, byteLength: 1000, dimensions: { width: 832, height: 1248 } }],
    ["undecodable", { mimeType: "image/png", byteLength: 1000, dimensions: null }],
    ["tiny", { mimeType: "image/png", byteLength: 1000, dimensions: { width: 200, height: 300 } }],
    ["huge", { mimeType: "image/png", byteLength: 1000, dimensions: { width: 4000, height: 6000 } }],
    ["landscape", { mimeType: "image/png", byteLength: 1000, dimensions: { width: 1248, height: 832 } }],
    ["3:4, just outside the tolerance", { mimeType: "image/webp", byteLength: 1000, dimensions: { width: 900, height: 1200 } }],
  ] as const)("refuse %s", (_label, facts) => {
    expect(checkGeneratedPreviewImage(facts).ok).toBe(false);
  });

  it("accept a JPEG or WebP portrait close to 2:3", () => {
    expect(checkGeneratedPreviewImage({ mimeType: "image/jpeg", byteLength: 500_000, dimensions: { width: 1024, height: 1536 } }).ok).toBe(true);
    expect(checkGeneratedPreviewImage({ mimeType: "image/webp", byteLength: 500_000, dimensions: { width: 896, height: 1280 } }).ok).toBe(true);
  });
});

describe("shop product pictures as preview input", () => {
  it("are allowed only over https from the shop's own domains (image hosts empty until S9)", () => {
    expect(SHOPS.every((shop) => Array.isArray(shop.imageHosts))).toBe(true);
    expect(shopImageUrlAllowed("https://www.next.co.uk/images/p.jpg", "next")).toBe(true);
    expect(shopImageUrlAllowed("http://www.next.co.uk/images/p.jpg", "next")).toBe(false);
    expect(shopImageUrlAllowed("https://www.next.co.uk:8443/p.jpg", "next")).toBe(false);
    expect(shopImageUrlAllowed("https://www.zara.com/p.jpg", "next")).toBe(false);
    expect(shopImageUrlAllowed("https://next.co.uk.evil.example/p.jpg", "next")).toBe(false);
    expect(shopImageUrlAllowed("not a url", "next")).toBe(false);
  });
});
