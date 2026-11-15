/**
 * QA (round 2, P1): adversarial checks on the preview contracts beyond
 * previews.test.ts: preset IDs and the settings schemas, the look's cache
 * key, and the generated-image checks fed with real hostile bytes (SVG, a
 * decompression bomb, a truncated PNG, a GIF) as the route will see them.
 *
 * `it.fails` marks a known bug reported to the orchestrator.
 */
import { crc32, deflateSync } from "node:zlib";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { PREVIEW_REPLY_GOOD } from "@/lib/ai/fixtures/preview-fixtures";
import { sniffImageType } from "@/lib/images/sniff";
import {
  DEFAULT_MODEL_PRESET_ID,
  MODEL_PRESETS,
  MODEL_PRESETS_BY_ID,
  ModelPresetIdSchema,
  OutfitPreviewSchema,
  PREVIEW_ASPECT_TOLERANCE,
  PREVIEW_OUTPUT_MAX_BYTES,
  PREVIEW_OUTPUT_MAX_SIDE_PX,
  PREVIEW_OUTPUT_MIN_SIDE_PX,
  PreviewCacheKeySchema,
  UpdateSettingsRequestSchema,
  UserSettingsSchema,
  checkGeneratedPreviewImage,
  previewCacheKey,
  type GeneratedImageFacts,
  type PreviewLook,
} from "@/contracts";

// ---------------------------------------------------------------------------
// Presets and settings
// ---------------------------------------------------------------------------

describe("QA: model preset IDs", () => {
  it.each([
    ["an unknown figure", "robot_average_medium"],
    ["curvy on the men's grid", "men_curvy_medium"],
    ["broad on the women's grid", "women_broad_deep"],
    ["a different case", "Women_Average_Medium"],
    ["padded with spaces", " women_average_medium "],
    ["a path", "../presets/women_average_medium"],
    ["the image path", "/presets/women_average_medium.webp"],
    ["the label", "Women's, average build, medium skin tone"],
    ["a prototype key", "__proto__"],
    ["an empty string", ""],
  ])("refuse %s", (_label, id) => {
    expect(ModelPresetIdSchema.safeParse(id).success).toBe(false);
    expect(MODEL_PRESETS_BY_ID.get(id)).toBeUndefined();
  });

  it("refuse non-strings", () => {
    for (const value of [null, undefined, 0, 1, true, {}, [], ["women_average_medium"]]) {
      expect(ModelPresetIdSchema.safeParse(value).success).toBe(false);
    }
  });

  it("every preset is found by its ID, and the default is the middle of the women's grid", () => {
    for (const p of MODEL_PRESETS) expect(MODEL_PRESETS_BY_ID.get(p.id)).toBe(p);
    expect(MODEL_PRESETS_BY_ID.get(DEFAULT_MODEL_PRESET_ID)).toMatchObject({ gender: "women", build: "average", skinTone: "medium" });
  });

  it("labels are unique, so the image model is never told two figures are the same", () => {
    expect(new Set(MODEL_PRESETS.map((p) => p.label)).size).toBe(MODEL_PRESETS.length);
  });
});

describe("QA: settings schemas with the preset", () => {
  const settings = { modelPresetId: "women_plus_deep", favouriteShopIds: ["next"], forwardingAddress: null };

  it("PUT can't clear the preset in any spelling", () => {
    for (const value of [null, "", " ", "none", "null", 0, false]) {
      expect(UpdateSettingsRequestSchema.safeParse({ modelPresetId: value }).success).toBe(false);
      // Not even next to a valid shops change.
      expect(UpdateSettingsRequestSchema.safeParse({ favouriteShopIds: ["next"], modelPresetId: value }).success).toBe(false);
    }
  });

  it("PUT with only an explicit undefined preset is 'neither', and refused", () => {
    expect(UpdateSettingsRequestSchema.safeParse({ modelPresetId: undefined }).success).toBe(false);
  });

  it("PUT strips fields a user mustn't set (the forwarding token, another user's id)", () => {
    const parsed = UpdateSettingsRequestSchema.parse({
      modelPresetId: "men_plus_light",
      forwardingToken: "a".repeat(32),
      userId: "0b000000-0000-4000-8000-000000000002",
      user_id: "0b000000-0000-4000-8000-000000000002",
    });
    expect(parsed).toEqual({ modelPresetId: "men_plus_light" });
  });

  // Changed by the orchestrator (QA finding on P4): an unknown stored preset
  // used to fail the whole settings read. It now reads as null ("not picked
  // yet"), so the user is simply asked to pick again. Setting one stays strict.
  it("GET reads a stored preset that's not on the list as null (not picked yet)", () => {
    expect(UserSettingsSchema.parse({ ...settings, modelPresetId: "women_broad_deep" }).modelPresetId).toBeNull();
    expect(UserSettingsSchema.parse({ ...settings, modelPresetId: undefined }).modelPresetId).toBeNull();
  });
});

describe("QA: the preview on an outfit", () => {
  const base = { status: "ready", imageUrl: "https://x.supabase.co/sign/p.webp", failureReason: null, presetId: "women_slim_light", suggestedSlots: [], outdated: false };

  it("refuses more than 3 suggested slots and an unknown slot", () => {
    expect(OutfitPreviewSchema.safeParse({ ...base, suggestedSlots: ["top", "bottom", "shoes", "outerwear"] }).success).toBe(false);
    expect(OutfitPreviewSchema.safeParse({ ...base, suggestedSlots: ["accessory"] }).success).toBe(false);
  });

  it("a skipped or failed preview never carries an image", () => {
    expect(OutfitPreviewSchema.safeParse({ ...base, status: "skipped", failureReason: "ai_paused" }).success).toBe(false);
    expect(OutfitPreviewSchema.safeParse({ ...base, status: "failed", failureReason: "internal" }).success).toBe(false);
    expect(OutfitPreviewSchema.safeParse({ ...base, status: "none" }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The cache key
// ---------------------------------------------------------------------------

describe("QA: previewCacheKey", () => {
  const ITEMS = [
    "1a000000-0000-4000-8000-000000000001",
    "1a000000-0000-4000-8000-000000000002",
    "1a000000-0000-4000-8000-000000000003",
  ];
  const look: PreviewLook = {
    presetId: "women_average_medium",
    itemIds: ITEMS,
    gaps: [{ category: "shoes", subcategory: "trainers", colours: ["white", "grey"], description: "White trainers", shopProduct: null }],
  };
  const key = () => previewCacheKey(look);

  it("is stable across every order of the items", async () => {
    const want = await key();
    const orders = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ];
    for (const order of orders) {
      expect(await previewCacheKey({ ...look, itemIds: order.map((i) => ITEMS[i]!) })).toBe(want);
    }
    expect(PreviewCacheKeySchema.safeParse(want).success).toBe(true);
  });

  it("is stable across gap order with three gaps", async () => {
    const gaps: PreviewLook["gaps"] = [
      { category: "shoes", subcategory: null, colours: ["black"], description: "Black boots" },
      { category: "outerwear", subcategory: null, colours: ["camel"], description: "Camel coat" },
      { category: "bottom", subcategory: null, colours: ["navy"], description: "Navy trousers" },
    ];
    const a = await previewCacheKey({ ...look, itemIds: [ITEMS[0]!], gaps });
    const b = await previewCacheKey({ ...look, itemIds: [ITEMS[0]!], gaps: [gaps[2]!, gaps[0]!, gaps[1]!] });
    expect(a).toBe(b);
  });

  it("doesn't change the caller's arrays (it sorts copies)", async () => {
    const itemIds = [ITEMS[2]!, ITEMS[0]!];
    const gaps = [...look.gaps];
    await previewCacheKey({ ...look, itemIds, gaps });
    expect(itemIds).toEqual([ITEMS[2], ITEMS[0]]);
    expect(gaps).toEqual(look.gaps);
  });

  it("changes with the preset", async () => {
    expect(await previewCacheKey({ ...look, presetId: "women_average_deep" })).not.toBe(await key());
  });

  it("changes when an item is swapped, added or removed", async () => {
    const want = await key();
    const variants = [
      [ITEMS[0]!, ITEMS[1]!],
      [...ITEMS, "1a000000-0000-4000-8000-000000000004"],
      [ITEMS[0]!, ITEMS[1]!, "1a000000-0000-4000-8000-000000000009"],
    ];
    const keys = await Promise.all(variants.map((itemIds) => previewCacheKey({ ...look, itemIds })));
    expect(new Set([want, ...keys]).size).toBe(variants.length + 1);
  });

  it("changes with the gap description, even by one character or case", async () => {
    const want = await key();
    for (const description of ["White trainers.", "white trainers", "White trainers ", "White  trainers"]) {
      expect(await previewCacheKey({ ...look, gaps: [{ ...look.gaps[0]!, description }] })).not.toBe(want);
    }
  });

  it("changes when a gap moves to another slot with the same words", async () => {
    expect(await previewCacheKey({ ...look, gaps: [{ ...look.gaps[0]!, category: "outerwear" }] })).not.toBe(await key());
  });

  it("changes with the colours' order (the first is the main one)", async () => {
    expect(await previewCacheKey({ ...look, gaps: [{ ...look.gaps[0]!, colours: ["grey", "white"] }] })).not.toBe(await key());
  });

  it("changes with the picked product, and between two products", async () => {
    const want = await key();
    const a = await previewCacheKey({ ...look, gaps: [{ ...look.gaps[0]!, shopProduct: { url: "https://www.next.co.uk/p/1" } }] });
    const b = await previewCacheKey({ ...look, gaps: [{ ...look.gaps[0]!, shopProduct: { url: "https://www.next.co.uk/p/2" } }] });
    expect(new Set([want, a, b]).size).toBe(3);
  });

  it("a cleared product (null) and no product (missing) are the same look", async () => {
    const { shopProduct: _dropped, ...withoutProduct } = look.gaps[0]!;
    expect(await previewCacheKey({ ...look, gaps: [withoutProduct] })).toBe(await key());
  });

  it("only the picked product's URL counts, not its title, price or image", async () => {
    const product = (extra: Record<string, unknown>) => ({ url: "https://www.next.co.uk/p/1", ...extra });
    const a = await previewCacheKey({ ...look, gaps: [{ ...look.gaps[0]!, shopProduct: product({ title: "A", price: "£10" }) }] });
    const b = await previewCacheKey({ ...look, gaps: [{ ...look.gaps[0]!, shopProduct: product({ title: "B", imageUrl: "https://x/y.jpg" }) }] });
    expect(a).toBe(b);
  });

  it("is unchanged by shop results, search time and other gap fields", async () => {
    const noisy = {
      ...look,
      gaps: look.gaps.map((g) => ({
        ...g,
        shopResults: [{ url: "https://www.next.co.uk/p/9", title: "x" }],
        searchedAt: new Date().toISOString(),
        anythingElse: 42,
      })),
    };
    expect(await previewCacheKey(noisy)).toBe(await key());
    expect(await previewCacheKey({ ...noisy, gaps: noisy.gaps.map((g) => ({ ...g, searchedAt: "2020-01-01T00:00:00Z", shopResults: [] })) })).toBe(await key());
  });

  it("can't be forged by moving text between fields (JSON, not concatenation)", async () => {
    const a = await previewCacheKey({ ...look, gaps: [{ category: "shoes", subcategory: "trainers", colours: ["white"], description: "x" }] });
    const b = await previewCacheKey({ ...look, gaps: [{ category: "shoes", subcategory: null, colours: ["white"], description: "trainers x" }] });
    const c = await previewCacheKey({ ...look, itemIds: [`${ITEMS[0]},${ITEMS[1]}`, ITEMS[2]!] });
    expect(a).not.toBe(b);
    expect(c).not.toBe(await key());
  });
});

// ---------------------------------------------------------------------------
// Generated image checks, fed real bytes
// ---------------------------------------------------------------------------

/**
 * Facts as the route should work them out: sniff the type from the bytes,
 * then fully decode (not just read the header) within a pixel limit, so a
 * truncated or bomb image reads as "doesn't decode".
 */
async function decodedFacts(data: Uint8Array): Promise<GeneratedImageFacts> {
  let dimensions: GeneratedImageFacts["dimensions"] = null;
  try {
    const { info } = await sharp(data, { limitInputPixels: PREVIEW_OUTPUT_MAX_SIDE_PX * PREVIEW_OUTPUT_MAX_SIDE_PX, failOn: "truncated" })
      .raw()
      .toBuffer({ resolveWithObject: true });
    dimensions = { width: info.width, height: info.height };
  } catch {
    dimensions = null;
  }
  return { mimeType: sniffImageType(data), byteLength: data.byteLength, dimensions };
}

/** A PNG whose header claims width x height, with a small IDAT: a decompression bomb's shape. */
function pngClaiming(width: number, height: number): Uint8Array {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // greyscale
  const idat = deflateSync(Buffer.alloc((width + 1) * 64)); // 64 rows of zeros; the rest is missing
  return new Uint8Array(
    Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]),
  );
}

const portrait = (format: "png" | "jpeg" | "webp" | "gif" | "tiff" | "avif", width = 832, height = 1248) =>
  sharp({ create: { width, height, channels: 3, background: "#ddd" } })
    .toFormat(format)
    .toBuffer()
    .then((b) => new Uint8Array(b));

const goodBytes = () => {
  if (PREVIEW_REPLY_GOOD === "throw" || !("image" in PREVIEW_REPLY_GOOD)) throw new Error("fixture");
  return PREVIEW_REPLY_GOOD.image.data;
};

describe("QA: checkGeneratedPreviewImage on real bytes", () => {
  it("accepts the good fixture and freshly made PNG, JPEG and WebP portraits", async () => {
    expect(checkGeneratedPreviewImage(await decodedFacts(goodBytes()))).toEqual({ ok: true });
    for (const format of ["png", "jpeg", "webp"] as const) {
      expect(checkGeneratedPreviewImage(await decodedFacts(await portrait(format)))).toEqual({ ok: true });
    }
  });

  it.each(["gif", "tiff", "avif"] as const)("refuses a %s portrait (not a type the model may return)", async (format) => {
    const facts = await decodedFacts(await portrait(format));
    expect(facts.mimeType).toBeNull();
    expect(checkGeneratedPreviewImage(facts)).toMatchObject({ ok: false, problem: expect.stringContaining("Unexpected image type") });
  });

  it("refuses an SVG, even one of the right size that sharp can render", async () => {
    const svg = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" width="832" height="1248"><script>alert(1)</script><rect width="832" height="1248"/></svg>',
    );
    const facts = await decodedFacts(svg);
    expect(facts.mimeType).toBeNull();
    expect(checkGeneratedPreviewImage(facts).ok).toBe(false);
    // Whatever the provider declared.
    expect(checkGeneratedPreviewImage({ ...facts, mimeType: "image/svg+xml" }).ok).toBe(false);
  });

  it("refuses a decompression bomb (a small PNG claiming 40000 x 60000)", async () => {
    const bomb = pngClaiming(40_000, 60_000);
    expect(bomb.byteLength).toBeLessThan(PREVIEW_OUTPUT_MAX_BYTES);
    const facts = await decodedFacts(bomb);
    expect(facts.mimeType).toBe("image/png");
    expect(checkGeneratedPreviewImage(facts).ok).toBe(false);
    // Even if a caller reads only the header, the size limit refuses it.
    expect(checkGeneratedPreviewImage({ ...facts, dimensions: { width: 40_000, height: 60_000 } }).ok).toBe(false);
  });

  it("refuses a bomb that claims a 2:3 size within the limits but whose data is missing", async () => {
    const facts = await decodedFacts(pngClaiming(2048, 3072));
    expect(checkGeneratedPreviewImage(facts)).toMatchObject({ ok: false, problem: "The image doesn't decode" });
  });

  it("refuses a truncated PNG (half the good fixture): its header alone would pass", async () => {
    const good = goodBytes();
    const half = good.subarray(0, Math.floor(good.byteLength / 2));
    const facts = await decodedFacts(half);
    expect(facts.mimeType).toBe("image/png");
    expect(checkGeneratedPreviewImage(facts)).toMatchObject({ ok: false, problem: "The image doesn't decode" });
    // The trap for the P2 route: sharp's metadata() reads the header only and
    // reports the full size, so facts from metadata() would let this through.
    const meta = await sharp(half).metadata();
    expect(checkGeneratedPreviewImage({ mimeType: "image/png", byteLength: half.byteLength, dimensions: { width: meta.width!, height: meta.height! } }).ok).toBe(true);
  });

  it("refuses a truncated JPEG", async () => {
    const jpeg = await portrait("jpeg");
    const facts = await decodedFacts(jpeg.subarray(0, Math.floor(jpeg.byteLength / 3)));
    expect(checkGeneratedPreviewImage(facts).ok).toBe(false);
  });

  it("refuses a too-small and a too-large portrait of the right shape", async () => {
    expect(checkGeneratedPreviewImage(await decodedFacts(await portrait("png", 340, 510)))).toMatchObject({ ok: false });
    expect(checkGeneratedPreviewImage({ mimeType: "image/png", byteLength: 1000, dimensions: { width: 2731, height: 4097 } })).toMatchObject({ ok: false });
  });

  it("refuses wrong aspect ratios: square, landscape, 3:4, 9:16", async () => {
    for (const [w, h] of [
      [1024, 1024],
      [1248, 832],
      [900, 1200],
      [720, 1280],
    ] as const) {
      expect(checkGeneratedPreviewImage(await decodedFacts(await portrait("png", w, h))).ok).toBe(false);
    }
  });

  it("refuses a reply over the byte limit, even a valid image", () => {
    expect(
      checkGeneratedPreviewImage({ mimeType: "image/png", byteLength: PREVIEW_OUTPUT_MAX_BYTES + 1, dimensions: { width: 832, height: 1248 } }).ok,
    ).toBe(false);
    expect(checkGeneratedPreviewImage({ mimeType: "image/png", byteLength: PREVIEW_OUTPUT_MAX_BYTES, dimensions: { width: 832, height: 1248 } }).ok).toBe(
      true,
    );
  });
});

describe("QA: checkGeneratedPreviewImage limits", () => {
  const facts = (width: number, height: number, mimeType: string | null = "image/png"): GeneratedImageFacts => ({
    mimeType,
    byteLength: 1000,
    dimensions: { width, height },
  });

  it("accepts the edges: 512 px short side, 4096 px long side, 5:8 and 0.7", () => {
    expect(checkGeneratedPreviewImage(facts(PREVIEW_OUTPUT_MIN_SIDE_PX, 768)).ok).toBe(true);
    expect(checkGeneratedPreviewImage(facts(2731, PREVIEW_OUTPUT_MAX_SIDE_PX)).ok).toBe(true);
    expect(checkGeneratedPreviewImage(facts(1000, 1600)).ok).toBe(true); // 0.625
    expect(checkGeneratedPreviewImage(facts(1050, 1500)).ok).toBe(true); // 0.7
  });

  it("refuses just past them", () => {
    expect(checkGeneratedPreviewImage(facts(PREVIEW_OUTPUT_MIN_SIDE_PX - 1, 768)).ok).toBe(false);
    expect(checkGeneratedPreviewImage(facts(2731, PREVIEW_OUTPUT_MAX_SIDE_PX + 1)).ok).toBe(false);
    const expected = 2 / 3;
    // Just outside the tolerance either side.
    expect(checkGeneratedPreviewImage(facts(Math.ceil((expected + PREVIEW_ASPECT_TOLERANCE + 0.002) * 1500), 1500)).ok).toBe(false);
    expect(checkGeneratedPreviewImage(facts(Math.floor((expected - PREVIEW_ASPECT_TOLERANCE - 0.002) * 1500), 1500)).ok).toBe(false);
  });

  it("refuses types by exact name only (no case games, no parameters, no lookalikes)", () => {
    for (const mimeType of ["IMAGE/PNG", "image/png; charset=binary", "image/jpg", "image/pjpeg", "image/heic", "image/svg+xml", "application/octet-stream", ""]) {
      expect(checkGeneratedPreviewImage(facts(832, 1248, mimeType)).ok).toBe(false);
    }
  });

  it("refuses nonsense dimensions", () => {
    for (const [w, h] of [
      [0, 0],
      [-832, -1248],
      [Number.NaN, Number.NaN],
      [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
      [832, 0],
    ]) {
      expect(checkGeneratedPreviewImage(facts(w!, h!)).ok).toBe(false);
    }
  });
});
