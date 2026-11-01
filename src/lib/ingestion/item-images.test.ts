/**
 * Changing an existing item's pictures: the cut-out a collage makes, and a
 * photo added later for an email item without one. Real images and sharp,
 * in-memory storage and items. No AI and no caps are involved.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STORAGE_BUCKETS, collageImageUrl, type ItemRow, type ItemTags } from "@/contracts";
import { ApiException } from "@/lib/api/errors";
import type { UploadedImage } from "@/lib/api/upload";
import type { ImageInput } from "@/lib/ai/types";
import { tagging } from "@/test/fixtures/model-output";
import { OTHER_USER, TEST_USER, makeTestDeps } from "@/test/ingestion-deps";
import { cutoutPng, opaquePngWithAlpha, phoneJpeg, phonePng, readMetadata } from "@/test/images";
import { replaceItemPhoto, setItemCutout } from "./item-images";
import { newImageKey } from "./storage";

type Deps = ReturnType<typeof makeTestDeps>;

function uploaded(image: ImageInput, name: string): UploadedImage {
  return { data: image.data, mimeType: image.mimeType, name };
}

/** An item with a stored (clean) 400×600 original, optionally a cut-out, as an email item may be. */
async function existingItem(
  deps: Deps,
  options: { userId?: string; cutout?: boolean; needsPhoto?: boolean; source?: "photo" | "email" } = {},
): Promise<ItemRow> {
  const userId = options.userId ?? TEST_USER;
  const original = await deps.images.stripMetadata(await phoneJpeg({ width: 400, height: 600 }));
  const originalKey = newImageKey(userId, "image/jpeg");
  await deps.storage.upload(STORAGE_BUCKETS.originals, originalKey, original);
  let cutoutKey: string | null = null;
  if (options.cutout) {
    cutoutKey = newImageKey(userId, "image/png");
    await deps.storage.upload(STORAGE_BUCKETS.cutouts, cutoutKey, await cutoutPng());
  }
  return deps.items.create(userId, {
    source: options.source ?? "photo",
    sourceUrl: null,
    originalImageKey: originalKey,
    cutoutImageKey: cutoutKey,
    tags: tagging.valid as ItemTags,
    tagsEdited: false,
    needsPhoto: options.needsPhoto ?? false,
  });
}

async function apiError(promise: Promise<unknown>): Promise<ApiException> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ApiException);
  return error as ApiException;
}

function objectCount(deps: Deps): number {
  return deps.storage.objects.size;
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("setItemCutout", () => {
  it("stores the cut-out without EXIF, points the item at it, and the collage uses it", async () => {
    const deps = makeTestDeps();
    const row = await existingItem(deps);

    const item = await setItemCutout(deps, TEST_USER, row.id, uploaded(await cutoutPng(), "cutout.png"));

    const stored = (await deps.items.get(TEST_USER, row.id))!;
    expect(stored.cutout_image_key).toMatch(new RegExp(`^${TEST_USER}/[0-9a-f-]{36}\\.png$`));
    expect(item.cutoutUrl).toContain(stored.cutout_image_key!);
    expect(collageImageUrl(item)).toBe(item.cutoutUrl);
    // The wardrobe still shows the original.
    expect(item.originalUrl).toContain(row.original_image_key);

    const meta = await readMetadata(deps.storage.get(STORAGE_BUCKETS.cutouts, stored.cutout_image_key!)!);
    expect(meta).toMatchObject({ format: "png", exif: undefined, hasAlpha: true, mentionsCamera: false });
    // Nothing else about the item changes, and no AI or cap was involved.
    expect(stored).toMatchObject({ needs_review: false, tags_edited: false, original_image_key: row.original_image_key });
    expect(deps.fakeTagger.calls).toHaveLength(0);
    expect(deps.usageStore.events).toHaveLength(0);
  });

  it("replaces an older cut-out and deletes its file", async () => {
    const deps = makeTestDeps();
    const row = await existingItem(deps, { cutout: true });
    const before = objectCount(deps);

    await setItemCutout(deps, TEST_USER, row.id, uploaded(await cutoutPng({ width: 300, height: 400 }), "cutout.png"));

    const stored = (await deps.items.get(TEST_USER, row.id))!;
    expect(stored.cutout_image_key).not.toBe(row.cutout_image_key);
    expect(await deps.storage.exists(STORAGE_BUCKETS.cutouts, row.cutout_image_key!)).toBe(false);
    expect(objectCount(deps)).toBe(before);
  });

  it("refuses a cut-out wider or taller than the item's original, storing nothing", async () => {
    const deps = makeTestDeps();
    const row = await existingItem(deps);
    const before = objectCount(deps);
    const error = await apiError(setItemCutout(deps, TEST_USER, row.id, uploaded(await cutoutPng({ width: 500, height: 300 }), "c.png")));
    expect(error.code).toBe("bad_request");
    expect(error.extras.issues?.[0]?.path).toBe("cutout");
    expect(objectCount(deps)).toBe(before);
    expect((await deps.items.get(TEST_USER, row.id))!.cutout_image_key).toBeNull();
  });

  it("refuses a PNG with no see-through background", async () => {
    const deps = makeTestDeps();
    const row = await existingItem(deps);
    const error = await apiError(setItemCutout(deps, TEST_USER, row.id, uploaded(await opaquePngWithAlpha(), "c.png")));
    expect(error.code).toBe("bad_request");
    expect(error.message).toMatch(/see-through/);
  });

  it("refuses a corrupt PNG as a bad request on the field", async () => {
    const deps = makeTestDeps();
    const row = await existingItem(deps);
    const png = await cutoutPng();
    const truncated = { ...png, data: png.data.slice(0, Math.floor(png.data.length / 2)) };
    const error = await apiError(setItemCutout(deps, TEST_USER, row.id, uploaded(truncated, "c.png")));
    expect(error.code).toBe("bad_request");
    expect(error.extras.issues?.[0]?.path).toBe("cutout");
  });

  it("answers not_found for someone else's item and stores nothing", async () => {
    const deps = makeTestDeps();
    const row = await existingItem(deps, { userId: OTHER_USER });
    const before = objectCount(deps);
    const error = await apiError(setItemCutout(deps, TEST_USER, row.id, uploaded(await cutoutPng(), "c.png")));
    expect(error.code).toBe("not_found");
    expect(objectCount(deps)).toBe(before);
    expect((await deps.items.get(OTHER_USER, row.id))!.cutout_image_key).toBeNull();
  });

  it("removes the new file when the item is deleted while the cut-out was being stored", async () => {
    const deps = makeTestDeps();
    const row = await existingItem(deps);
    const setCutoutKey = deps.items.setCutoutKey.bind(deps.items);
    vi.spyOn(deps.items, "setCutoutKey").mockImplementation(async (userId, id, key, madeFrom) => {
      await deps.items.delete(userId, id);
      return setCutoutKey(userId, id, key, madeFrom);
    });
    const error = await apiError(setItemCutout(deps, TEST_USER, row.id, uploaded(await cutoutPng(), "c.png")));
    expect(error.code).toBe("not_found");
    const cutouts = [...deps.storage.objects.keys()].filter((id) => id.startsWith(`${STORAGE_BUCKETS.cutouts}/`));
    expect(cutouts).toEqual([]);
  });
});

describe("setItemCutout: review fixes", () => {
  it("refuses an item still waiting for a photo before reading any image", async () => {
    const deps = makeTestDeps();
    const row = await existingItem(deps, { source: "email", needsPhoto: true });
    const download = vi.spyOn(deps.storage, "download");
    const before = objectCount(deps);
    const error = await apiError(setItemCutout(deps, TEST_USER, row.id, uploaded(await cutoutPng(), "c.png")));
    expect(error.code).toBe("bad_request");
    expect(error.message).toMatch(/Add a photo first/);
    expect(download).not.toHaveBeenCalled();
    expect(objectCount(deps)).toBe(before);
  });

  it("answers not_found, not a 500, when the item is deleted before its original is read", async () => {
    const deps = makeTestDeps();
    const row = await existingItem(deps);
    const download = deps.storage.download.bind(deps.storage);
    vi.spyOn(deps.storage, "download").mockImplementationOnce(async (bucket, key) => {
      await deps.items.delete(TEST_USER, row.id);
      await deps.storage.remove(bucket, [key]);
      return download(bucket, key);
    });
    const error = await apiError(setItemCutout(deps, TEST_USER, row.id, uploaded(await cutoutPng(), "c.png")));
    expect(error.code).toBe("not_found");
  });

  it("still fails as a server error when the original is missing but the item is there", async () => {
    const deps = makeTestDeps();
    const row = await existingItem(deps);
    await deps.storage.remove(STORAGE_BUCKETS.originals, [row.original_image_key]);
    await expect(setItemCutout(deps, TEST_USER, row.id, uploaded(await cutoutPng(), "c.png"))).rejects.not.toBeInstanceOf(ApiException);
  });

  it("doesn't attach a cut-out of the old picture after the photo was replaced, and removes its file", async () => {
    const deps = makeTestDeps();
    const row = await existingItem(deps);
    const setCutoutKey = deps.items.setCutoutKey.bind(deps.items);
    vi.spyOn(deps.items, "setCutoutKey").mockImplementationOnce(async (userId, id, key, madeFrom) => {
      await replaceItemPhoto(deps, userId, id, uploaded(await phoneJpeg({ width: 800, height: 600 }), "new.jpg"));
      return setCutoutKey(userId, id, key, madeFrom);
    });
    const error = await apiError(setItemCutout(deps, TEST_USER, row.id, uploaded(await cutoutPng(), "c.png")));
    expect(error.code).toBe("not_found");
    expect(error.message).toMatch(/photo changed/);
    const after = (await deps.items.get(TEST_USER, row.id))!;
    expect(after.cutout_image_key).toBeNull();
    const cutouts = [...deps.storage.objects.keys()].filter((id) => id.startsWith(`${STORAGE_BUCKETS.cutouts}/`));
    expect(cutouts).toEqual([]);
  });
});

describe("replaceItemPhoto", () => {
  it("replaces the placeholder, clears needsPhoto, marks the item to review and keeps the tags", async () => {
    const deps = makeTestDeps();
    const row = await existingItem(deps, { source: "email", needsPhoto: true, cutout: true });

    const item = await replaceItemPhoto(deps, TEST_USER, row.id, uploaded(await phoneJpeg({ width: 1200, height: 1600, orientation: 6 }), "IMG.jpg"));

    expect(item).toMatchObject({ needsPhoto: false, needsReview: true, cutoutUrl: null, tags: tagging.valid, tagsEdited: false, source: "email" });
    const stored = (await deps.items.get(TEST_USER, row.id))!;
    expect(stored.original_image_key).not.toBe(row.original_image_key);
    expect(item.originalUrl).toContain(stored.original_image_key);

    // EXIF (location included) stripped, picture upright.
    const meta = await readMetadata(deps.storage.get(STORAGE_BUCKETS.originals, stored.original_image_key)!);
    expect(meta).toMatchObject({ format: "jpeg", exif: undefined, orientation: undefined, mentionsCamera: false });
    expect([meta.width, meta.height]).toEqual([1600, 1200]);

    // The old placeholder and the cut-out (cut from it) are gone.
    expect(await deps.storage.exists(STORAGE_BUCKETS.originals, row.original_image_key)).toBe(false);
    expect(await deps.storage.exists(STORAGE_BUCKETS.cutouts, row.cutout_image_key!)).toBe(false);
    expect(deps.storage.objects.size).toBe(1);

    // No re-tagging, nothing counted.
    expect(deps.fakeTagger.calls).toHaveLength(0);
    expect(deps.usageStore.events).toHaveLength(0);
  });

  it("accepts PNG and keeps its type", async () => {
    const deps = makeTestDeps();
    const row = await existingItem(deps, { needsPhoto: true });
    await replaceItemPhoto(deps, TEST_USER, row.id, uploaded(await phonePng(), "shot.png"));
    expect((await deps.items.get(TEST_USER, row.id))!.original_image_key).toMatch(/\.png$/);
  });

  it("refuses a photo over 1600 px and leaves the item as it was", async () => {
    const deps = makeTestDeps();
    const row = await existingItem(deps, { needsPhoto: true });
    const error = await apiError(replaceItemPhoto(deps, TEST_USER, row.id, uploaded(await phoneJpeg({ width: 1700, height: 1000 }), "big.jpg")));
    expect(error.code).toBe("bad_request");
    expect(error.extras.issues?.[0]?.path).toBe("original");
    expect(await deps.items.get(TEST_USER, row.id)).toEqual(row);
    expect(await deps.storage.exists(STORAGE_BUCKETS.originals, row.original_image_key)).toBe(true);
  });

  it("answers not_found for someone else's item", async () => {
    const deps = makeTestDeps();
    const row = await existingItem(deps, { userId: OTHER_USER, needsPhoto: true });
    const error = await apiError(replaceItemPhoto(deps, TEST_USER, row.id, uploaded(await phoneJpeg(), "a.jpg")));
    expect(error.code).toBe("not_found");
    expect((await deps.items.get(OTHER_USER, row.id))!.needs_photo).toBe(true);
  });

  it("still succeeds if the old file can't be deleted (the cleanup job catches it)", async () => {
    const deps = makeTestDeps();
    const row = await existingItem(deps, { needsPhoto: true });
    vi.spyOn(deps.storage, "remove").mockRejectedValueOnce(new Error("storage down"));
    const item = await replaceItemPhoto(deps, TEST_USER, row.id, uploaded(await phoneJpeg(), "a.jpg"));
    expect(item.needsPhoto).toBe(false);
  });
});
