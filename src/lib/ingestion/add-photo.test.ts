/**
 * addItemFromPhoto with real images and sharp, in-memory storage, a fake
 * tagger (recorded outputs) and a real UsageGuard. Covers the spec's steps:
 * caps, checks, alpha, EXIF stripping, storage, tagging with retry and
 * fallback, and cost recording.
 */
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ESTIMATED_COST_PENCE } from "@/lib/usage/config";
import { STORAGE_BUCKETS } from "@/contracts";
import type { ModelCall, TaggingProvider } from "@/lib/ai/types";
import { ApiException } from "@/lib/api/errors";
import type { PhotoUpload } from "@/lib/api/upload";
import { CapReachedError } from "@/lib/usage/errors";
import { TEST_USER, makeTestDeps } from "@/test/ingestion-deps";
import { tagging } from "@/test/fixtures/model-output";
import { cutoutPng, opaquePngWithAlpha, phoneJpeg, readMetadata } from "@/test/images";
import { addItemFromPhoto, removeQuietly } from "./add-photo";
import type { ImageStorage } from "./storage";

async function upload(options: { cutout?: boolean | "opaque"; width?: number; height?: number; sourceUrl?: string } = {}): Promise<PhotoUpload> {
  const original = await phoneJpeg({ width: options.width ?? 1200, height: options.height ?? 1600, orientation: 6 });
  const cutout =
    options.cutout === "opaque" ? await opaquePngWithAlpha() : options.cutout === false ? null : await cutoutPng();
  return {
    original: { ...original, name: "IMG_0001.jpg" },
    cutout: cutout ? { ...cutout, name: "cutout.png" } : null,
    sourceUrl: options.sourceUrl,
  };
}

async function apiError(promise: Promise<unknown>): Promise<ApiException> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ApiException);
  return error as ApiException;
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("addItemFromPhoto: the happy path", () => {
  it("stores both images without EXIF, tags the cut-out, counts the item and records the cost", async () => {
    const deps = makeTestDeps({ taggerOutputs: [JSON.stringify(tagging.valid)] });
    const draft = await addItemFromPhoto(deps, TEST_USER, await upload());

    expect(draft).toMatchObject({ source: "photo", sourceUrl: null, suggestedTags: tagging.valid });
    expect(draft.originalImageKey).toMatch(new RegExp(`^${TEST_USER}/[0-9a-f-]{36}\\.jpg$`));
    expect(draft.cutoutImageKey).toMatch(new RegExp(`^${TEST_USER}/[0-9a-f-]{36}\\.png$`));
    expect(draft.originalUrl).toContain(draft.originalImageKey);
    expect(draft.cutoutUrl).toContain(draft.cutoutImageKey!);

    // Stored copies: no EXIF or camera details, upright, cut-out still transparent.
    const original = deps.storage.get(STORAGE_BUCKETS.originals, draft.originalImageKey)!;
    const cutout = deps.storage.get(STORAGE_BUCKETS.cutouts, draft.cutoutImageKey!)!;
    const originalMeta = await readMetadata(original);
    expect(originalMeta).toMatchObject({ format: "jpeg", exif: undefined, orientation: undefined, mentionsCamera: false });
    expect([originalMeta.width, originalMeta.height]).toEqual([1600, 1200]); // orientation 6 applied
    const cutoutMeta = await readMetadata(cutout);
    expect(cutoutMeta).toMatchObject({ format: "png", exif: undefined, hasAlpha: true, mentionsCamera: false });

    // The model saw the cut-out, flattened to a small JPEG.
    expect(deps.fakeTagger.calls).toHaveLength(1);
    const sent = deps.fakeTagger.calls[0]!.image;
    expect(sent.mimeType).toBe("image/jpeg");
    const sentMeta = await sharp(sent.data).metadata();
    expect([sentMeta.width, sentMeta.height]).toEqual([200, 300]); // the cut-out's size, not the photo's

    const kinds = deps.usageStore.events.map((e) => e.kind);
    expect(kinds).toEqual(["item_ingest", "tagging"]);
  });

  it("tags the original when there's no cut-out (removal failed on the phone)", async () => {
    const deps = makeTestDeps({ taggerOutputs: [tagging.valid] });
    const draft = await addItemFromPhoto(deps, TEST_USER, await upload({ cutout: false }));
    expect(draft).toMatchObject({ cutoutImageKey: null, cutoutUrl: null });
    const sentMeta = await sharp(deps.fakeTagger.calls[0]!.image.data).metadata();
    expect(Math.max(sentMeta.width!, sentMeta.height!)).toBe(768);
  });

  it("treats a PNG with no transparent pixels as no cut-out, and doesn't store it", async () => {
    const deps = makeTestDeps({ taggerOutputs: [tagging.valid] });
    const draft = await addItemFromPhoto(deps, TEST_USER, await upload({ cutout: "opaque" }));
    expect(draft.cutoutImageKey).toBeNull();
    expect(await deps.storage.listObjects(STORAGE_BUCKETS.cutouts, TEST_USER)).toEqual([]);
  });

  it("keeps the link for the add-by-link screenshot fallback", async () => {
    const deps = makeTestDeps({ taggerOutputs: [tagging.valid] });
    const draft = await addItemFromPhoto(deps, TEST_USER, await upload({ sourceUrl: "https://shop.example.com/p/1" }));
    expect(draft).toMatchObject({ source: "link", sourceUrl: "https://shop.example.com/p/1" });
  });
});

describe("addItemFromPhoto: tagging validation, retry and fallback", () => {
  it("retries once after an invalid reply and uses the second", async () => {
    const deps = makeTestDeps({ taggerOutputs: [tagging.invalidCategory, JSON.stringify(tagging.valid)] });
    const draft = await addItemFromPhoto(deps, TEST_USER, await upload());
    expect(draft.suggestedTags).toEqual(tagging.valid);
    expect(deps.fakeTagger.calls).toHaveLength(2);
    expect(deps.usageStore.events.filter((e) => e.kind === "tagging")).toHaveLength(2);
  });

  it("returns empty tags (null) after two invalid replies, and still stores the images", async () => {
    const deps = makeTestDeps({ taggerOutputs: [tagging.truncatedJson, tagging.prose, tagging.valid] });
    const draft = await addItemFromPhoto(deps, TEST_USER, await upload());
    expect(draft.suggestedTags).toBeNull();
    expect(deps.fakeTagger.calls).toHaveLength(2); // never a third call
    expect(await deps.storage.exists(STORAGE_BUCKETS.originals, draft.originalImageKey)).toBe(true);
  });

  it("falls back to empty tags when the provider throws twice, recording estimated costs", async () => {
    const failing: TaggingProvider = {
      name: "gemini",
      tagItem: vi.fn(async (): Promise<ModelCall> => {
        throw new Error("503 high demand");
      }),
    };
    const deps = makeTestDeps({ tagger: failing });
    const draft = await addItemFromPhoto(deps, TEST_USER, await upload());
    expect(draft.suggestedTags).toBeNull();
    expect(failing.tagItem).toHaveBeenCalledTimes(2);
    const costs = deps.usageStore.events.filter((e) => e.kind === "tagging");
    expect(costs.map((e) => [e.costPence, e.provider])).toEqual([
      [ESTIMATED_COST_PENCE.tagging, "gemini"],
      [ESTIMATED_COST_PENCE.tagging, "gemini"],
    ]);
  });
});

describe("addItemFromPhoto: rejected uploads", () => {
  it("refuses an original over 1600 px, without storing or counting anything", async () => {
    const deps = makeTestDeps({ taggerOutputs: [tagging.valid] });
    const error = await apiError(addItemFromPhoto(deps, TEST_USER, await upload({ width: 1601, height: 900 })));
    expect(error.code).toBe("bad_request");
    expect(error.extras.issues).toEqual([{ path: "original", message: "Must be at most 1600 px on its longest side" }]);
    expect(deps.storage.objects.size).toBe(0);
    expect(deps.usageStore.events).toEqual([]);
    expect(deps.fakeTagger.calls).toHaveLength(0);
  });

  it("refuses a cut-out over 1600 px", async () => {
    const deps = makeTestDeps({ taggerOutputs: [tagging.valid] });
    const big = await cutoutPng({ width: 1700, height: 200 });
    const request = { ...(await upload()), cutout: { ...big, name: "cutout.png" } };
    const error = await apiError(addItemFromPhoto(deps, TEST_USER, request));
    expect(error.extras.issues?.[0]?.path).toBe("cutout");
    expect(deps.storage.objects.size).toBe(0);
  });

  it("refuses bytes that pass the type sniff but aren't a real image", async () => {
    const deps = makeTestDeps({ taggerOutputs: [tagging.valid] });
    const fake = { data: Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), mimeType: "image/jpeg" as const, name: "x.jpg" };
    const error = await apiError(addItemFromPhoto(deps, TEST_USER, { original: fake, cutout: null, sourceUrl: undefined }));
    expect(error.extras.issues).toEqual([{ path: "original", message: "Not a readable image" }]);
  });
});

describe("addItemFromPhoto: caps", () => {
  it("allows the daily item cap, then refuses with items_per_day before touching the images", async () => {
    const deps = makeTestDeps({ taggerOutputs: [tagging.valid] });
    for (let i = 0; i < 3; i++) await addItemFromPhoto(deps, TEST_USER, await upload({ cutout: false }));
    const stored = deps.storage.objects.size;
    const error = await addItemFromPhoto(deps, TEST_USER, await upload()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CapReachedError);
    expect((error as CapReachedError).cap).toBe("items_per_day");
    expect((error as CapReachedError).toApiException().code).toBe("daily_cap_reached");
    expect(deps.storage.objects.size).toBe(stored);
    expect(deps.fakeTagger.calls).toHaveLength(3);
  });

  it("refuses with ai_paused once the month's AI spend reaches the cap, and doesn't count the item", async () => {
    const deps = makeTestDeps({ taggerOutputs: [tagging.valid] });
    await deps.usage.recordAiCost(null, "tagging", 1, "gemini"); // the test cap is 1p
    const error = await addItemFromPhoto(deps, TEST_USER, await upload()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CapReachedError);
    expect((error as CapReachedError).toApiException().code).toBe("ai_paused");
    expect(deps.storage.objects.size).toBe(0);
    expect(deps.usageStore.events.filter((e) => e.kind === "item_ingest")).toHaveLength(0);
  });

  it("records the provider's real cost when it reports one", async () => {
    const tagger: TaggingProvider = {
      name: "gemini",
      tagItem: async () => ({ raw: tagging.valid, costPence: 0.123, provider: "gemini", model: "test" }),
    };
    const deps = makeTestDeps({ tagger });
    await addItemFromPhoto(deps, TEST_USER, await upload());
    expect(deps.usageStore.events.find((e) => e.kind === "tagging")?.costPence).toBe(0.123);
  });
});

describe("addItemFromPhoto: cut-out rules", () => {
  /** An unrotated 800×600 photo with a cut-out of the given size. */
  async function withCutout(width: number, height: number): Promise<PhotoUpload> {
    return {
      original: { ...(await phoneJpeg({ width: 800, height: 600 })), name: "IMG.jpg" },
      cutout: { ...(await cutoutPng({ width, height })), name: "c.png" },
      sourceUrl: undefined,
    };
  }

  it.each([
    ["wider", 801, 300],
    ["taller", 300, 601],
  ])("refuses a cut-out %s than the photo with a 400 on `cutout`", async (_label, width, height) => {
    const deps = makeTestDeps({ taggerOutputs: [tagging.valid] });
    const error = await apiError(addItemFromPhoto(deps, TEST_USER, await withCutout(width, height)));
    expect(error.extras.issues).toEqual([{ path: "cutout", message: "Must not be larger than the photo it was cut from" }]);
    expect(deps.storage.objects.size).toBe(0);
    expect(deps.usageStore.events).toEqual([]);
  });

  it("accepts a cut-out exactly the photo's size", async () => {
    const deps = makeTestDeps({ taggerOutputs: [tagging.valid] });
    expect((await addItemFromPhoto(deps, TEST_USER, await withCutout(800, 600))).cutoutImageKey).not.toBeNull();
  });

  it("compares against the upright photo: a rotated phone JPEG and a matching cut-out are fine", async () => {
    const deps = makeTestDeps({ taggerOutputs: [tagging.valid] });
    // Stored 1600×1200 with orientation 6, i.e. 1200×1600 upright, like the cut-out.
    const original = await phoneJpeg({ width: 1600, height: 1200, orientation: 6 });
    const request = {
      original: { ...original, name: "IMG.jpg" },
      cutout: { ...(await cutoutPng({ width: 1200, height: 1600 })), name: "c.png" },
      sourceUrl: undefined,
    };
    expect((await addItemFromPhoto(deps, TEST_USER, request)).cutoutImageKey).not.toBeNull();
  });

  it("treats a cut-out with under 1% see-through pixels as no cut-out", async () => {
    const deps = makeTestDeps({ taggerOutputs: [tagging.valid] });
    const rgba = Buffer.alloc(200 * 300 * 4, 255);
    for (let i = 0; i < 500; i++) rgba[i * 4 + 3] = 0; // 0.83%
    const png = await sharp(rgba, { raw: { width: 200, height: 300, channels: 4 } }).png().toBuffer();
    const request = { ...(await upload()), cutout: { data: new Uint8Array(png), mimeType: "image/png" as const, name: "c.png" } };
    const draft = await addItemFromPhoto(deps, TEST_USER, request);
    expect(draft.cutoutImageKey).toBeNull();
    expect(await deps.storage.listObjects(STORAGE_BUCKETS.cutouts, TEST_USER)).toEqual([]);
  });
});

describe("addItemFromPhoto: storage failures leave nothing behind", () => {
  it("doesn't count the item if storing the original fails", async () => {
    const deps = makeTestDeps({ taggerOutputs: [tagging.valid] });
    const storage: ImageStorage = Object.create(deps.storage);
    storage.upload = async () => {
      throw new Error("storage down");
    };
    await expect(addItemFromPhoto({ ...deps, storage }, TEST_USER, await upload())).rejects.toThrow("storage down");
    expect(deps.usageStore.events).toEqual([]);
    expect(deps.fakeTagger.calls).toHaveLength(0);
  });

  it("removeQuietly tries every removal even if one fails", async () => {
    const deps = makeTestDeps();
    const removed: string[] = [];
    const storage: ImageStorage = Object.create(deps.storage);
    storage.remove = async (bucket, keys) => {
      removed.push(`${bucket}/${keys.join()}`);
      if (bucket === STORAGE_BUCKETS.originals) throw new Error("storage down");
    };
    await removeQuietly(storage, { originalKey: "o.jpg", cutoutKey: "c.png" });
    expect(removed.sort()).toEqual(["cutouts/c.png", "originals/o.jpg"]);
  });

  it("removes the original if storing the cut-out fails", async () => {
    const deps = makeTestDeps({ taggerOutputs: [tagging.valid] });
    const storage: ImageStorage = Object.create(deps.storage);
    storage.upload = async (bucket, key, image) => {
      if (bucket === STORAGE_BUCKETS.cutouts) throw new Error("storage down");
      return deps.storage.upload(bucket, key, image);
    };
    await expect(addItemFromPhoto({ ...deps, storage }, TEST_USER, await upload())).rejects.toThrow("storage down");
    expect(deps.storage.objects.size).toBe(0);
  });

  it("removes both images if signing their URLs fails", async () => {
    const deps = makeTestDeps({ taggerOutputs: [tagging.valid] });
    const storage: ImageStorage = Object.create(deps.storage);
    storage.signedUrls = async () => new Map();
    await expect(addItemFromPhoto({ ...deps, storage }, TEST_USER, await upload())).rejects.toThrow(/sign/);
    expect(deps.storage.objects.size).toBe(0);
  });
});
