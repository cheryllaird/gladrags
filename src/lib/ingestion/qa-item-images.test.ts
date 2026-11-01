/**
 * QA gap tests for changing an existing item's pictures (CONTRACTS.md
 * section 5, "Cut-out for an existing item" and "Adding a photo later"):
 * hostile and awkward files, ownership, items deleted mid-request, racing
 * uploads, and which files are deleted afterwards.
 *
 * Real images and sharp, in-memory storage and items. No AI, no network.
 *
 * Known bugs are pinned with it.fails and named "BUG:" so the suite stays
 * green until they're fixed; remove `.fails` when they are.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STORAGE_BUCKETS, type ItemRow, type ItemTags } from "@/contracts";
import type { ImageInput } from "@/lib/ai/types";
import { ApiException } from "@/lib/api/errors";
import type { UploadedImage } from "@/lib/api/upload";
import { tagging } from "@/test/fixtures/model-output";
import { cutoutPng, phoneJpeg, phoneWebp, rgbPng } from "@/test/images";
import { OTHER_USER, TEST_USER, makeTestDeps } from "@/test/ingestion-deps";
import {
  apngLike,
  jpegWithEveryMetadataSegment,
  leaksMetadata,
  pngBomb,
  pngClaimingHugeDimensions,
  pngNearlyOpaque,
  pngWithEveryMetadataChunk,
  pngWithOneTransparentPixel,
  truncated,
  webpWithExifAndXmp,
} from "@/test/qa-hostile-images";
import { replaceItemPhoto, setItemCutout } from "./item-images";
import { newImageKey } from "./storage";
import { deleteWardrobeItem } from "./wardrobe";

type Deps = ReturnType<typeof makeTestDeps>;

const named = (image: ImageInput, name = "file"): UploadedImage => ({ data: image.data, mimeType: image.mimeType, name });

/** An item with a stored, clean original of the given size, and optionally a cut-out. */
async function existingItem(
  deps: Deps,
  options: { userId?: string; cutout?: boolean; needsPhoto?: boolean; width?: number; height?: number; tagsEdited?: boolean } = {},
): Promise<ItemRow> {
  const userId = options.userId ?? TEST_USER;
  const original = await deps.images.stripMetadata(await phoneJpeg({ width: options.width ?? 400, height: options.height ?? 600 }));
  const originalKey = newImageKey(userId, "image/jpeg");
  await deps.storage.upload(STORAGE_BUCKETS.originals, originalKey, original);
  let cutoutKey: string | null = null;
  if (options.cutout) {
    cutoutKey = newImageKey(userId, "image/png");
    await deps.storage.upload(STORAGE_BUCKETS.cutouts, cutoutKey, await cutoutPng());
  }
  return deps.items.create(userId, {
    source: options.needsPhoto ? "email" : "photo",
    sourceUrl: null,
    originalImageKey: originalKey,
    cutoutImageKey: cutoutKey,
    tags: tagging.valid as ItemTags,
    tagsEdited: options.tagsEdited ?? false,
    needsPhoto: options.needsPhoto ?? false,
  });
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected the request to fail");
    },
    (e: unknown) => e,
  );
}

async function badRequestOn(promise: Promise<unknown>, field: string): Promise<ApiException> {
  const error = await rejection(promise);
  expect(error).toBeInstanceOf(ApiException);
  expect((error as ApiException).code).toBe("bad_request");
  expect((error as ApiException).extras.issues?.[0]?.path).toBe(field);
  return error as ApiException;
}

function keysIn(deps: Deps, bucket: string): string[] {
  return [...deps.storage.objects.keys()].filter((id) => id.startsWith(`${bucket}/`)).map((id) => id.slice(bucket.length + 1));
}

/** Every key an item row points at must exist in storage. */
async function rowFilesExist(deps: Deps, row: ItemRow): Promise<void> {
  expect(await deps.storage.exists(STORAGE_BUCKETS.originals, row.original_image_key)).toBe(true);
  if (row.cutout_image_key) expect(await deps.storage.exists(STORAGE_BUCKETS.cutouts, row.cutout_image_key)).toBe(true);
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------------------
// PUT /api/items/[id]/cutout
// ---------------------------------------------------------------------------

describe("setItemCutout: refused files leave the item and storage as they were", () => {
  async function refused(file: ImageInput, options: Parameters<typeof existingItem>[1] = {}) {
    const deps = makeTestDeps();
    const row = await existingItem(deps, options);
    const before = new Set(deps.storage.objects.keys());
    const error = await badRequestOn(setItemCutout(deps, TEST_USER, row.id, named(file, "c.png")), "cutout");
    expect(new Set(deps.storage.objects.keys())).toEqual(before);
    expect(await deps.items.get(TEST_USER, row.id)).toEqual(row);
    return error;
  }

  it("a PNG with no alpha channel at all", async () => {
    const error = await refused(await rgbPng());
    expect(error.message).toMatch(/see-through/);
  });

  it("a PNG whose alpha is 254 everywhere (not see-through)", async () => {
    await refused(await pngNearlyOpaque());
  });

  it("a PNG with one see-through pixel out of 400 (under 1%)", async () => {
    await refused(await pngWithOneTransparentPixel());
  });

  it("a PNG taller (only) than the original", async () => {
    const error = await refused(await cutoutPng({ width: 100, height: 601 }));
    expect(error.message).toMatch(/larger than the photo/);
  });

  it("an older cut-out stays when a new one is refused", async () => {
    const deps = makeTestDeps();
    const row = await existingItem(deps, { cutout: true });
    await badRequestOn(setItemCutout(deps, TEST_USER, row.id, named(await rgbPng())), "cutout");
    expect((await deps.items.get(TEST_USER, row.id))!.cutout_image_key).toBe(row.cutout_image_key);
    expect(await deps.storage.exists(STORAGE_BUCKETS.cutouts, row.cutout_image_key!)).toBe(true);
  });

  it("a decompression bomb (10,000 × 10,000 px from a small file)", async () => {
    await refused(await pngBomb());
  });

  it("a PNG whose header claims 60,000 × 60,000 px", async () => {
    await refused(await pngClaimingHugeDimensions());
  });

  it("a PNG over 1600 px even when the original is as large", async () => {
    // An original can't be over 1600 px either, so the pixel limit is the one that applies.
    await refused(await cutoutPng({ width: 1700, height: 1700 }), { width: 1600, height: 1600 });
  });

  it("a truncated PNG", async () => {
    await refused(truncated(await cutoutPng(), 0.6));
  });

  it("garbage after a valid PNG signature", async () => {
    const bytes = new Uint8Array(4096);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    for (let i = 8; i < bytes.length; i++) bytes[i] = (i * 31) % 256;
    await refused({ data: bytes, mimeType: "image/png" });
  });

  it("a JPEG or WebP passed in as if it were the cut-out (the route's parser normally stops these)", async () => {
    await refused(await phoneJpeg({ width: 100, height: 100 }));
    await refused(await phoneWebp({ width: 100, height: 100 }));
  });
});

describe("setItemCutout: accepted edge cases", () => {
  it("a cut-out exactly the size of the original", async () => {
    const deps = makeTestDeps();
    const row = await existingItem(deps, { width: 400, height: 600 });
    const item = await setItemCutout(deps, TEST_USER, row.id, named(await cutoutPng({ width: 400, height: 600 })));
    expect(item.cutoutUrl).not.toBeNull();
  });

  it("strips every metadata chunk (EXIF, XMP, text) from the stored cut-out and keeps it see-through", async () => {
    const deps = makeTestDeps();
    const row = await existingItem(deps);
    await setItemCutout(deps, TEST_USER, row.id, named(await pngWithEveryMetadataChunk({ alpha: true })));
    const key = (await deps.items.get(TEST_USER, row.id))!.cutout_image_key!;
    const stored = deps.storage.get(STORAGE_BUCKETS.cutouts, key)!;
    expect(leaksMetadata(stored.data)).toEqual([]);
    expect(await deps.images.hasTransparency(stored)).toBe(true);
  });

  it("an APNG is stored as a still PNG", async () => {
    const deps = makeTestDeps();
    const row = await existingItem(deps);
    await setItemCutout(deps, TEST_USER, row.id, named(await apngLike()));
    const key = (await deps.items.get(TEST_USER, row.id))!.cutout_image_key!;
    expect(Buffer.from(deps.storage.get(STORAGE_BUCKETS.cutouts, key)!.data).includes("acTL")).toBe(false);
  });

  it("only touches the cut-out: the original file, tags and flags are unchanged", async () => {
    const deps = makeTestDeps();
    const row = await existingItem(deps, { cutout: true, tagsEdited: true });
    await setItemCutout(deps, TEST_USER, row.id, named(await cutoutPng()));
    const after = (await deps.items.get(TEST_USER, row.id))!;
    expect({ ...after, cutout_image_key: null }).toEqual({ ...row, cutout_image_key: null });
    expect(await deps.storage.exists(STORAGE_BUCKETS.originals, row.original_image_key)).toBe(true);
  });
});

describe("setItemCutout: ownership", () => {
  it("another user's item: not_found, their cut-out isn't replaced or deleted, nothing is stored or downloaded", async () => {
    const deps = makeTestDeps();
    const theirs = await existingItem(deps, { userId: OTHER_USER, cutout: true });
    const download = vi.spyOn(deps.storage, "download");
    const before = new Set(deps.storage.objects.keys());

    const error = await rejection(setItemCutout(deps, TEST_USER, theirs.id, named(await cutoutPng())));
    expect((error as ApiException).code).toBe("not_found");
    expect(download).not.toHaveBeenCalled();
    expect(new Set(deps.storage.objects.keys())).toEqual(before);
    expect(await deps.items.get(OTHER_USER, theirs.id)).toEqual(theirs);
  });

  it("an unknown item ID: not_found", async () => {
    const deps = makeTestDeps();
    const error = await rejection(setItemCutout(deps, TEST_USER, "1a000000-0000-4000-8000-0000000009ff", named(await cutoutPng())));
    expect((error as ApiException).code).toBe("not_found");
    expect(deps.storage.objects.size).toBe(0);
  });

  it("the new key is in the signed-in user's folder", async () => {
    const deps = makeTestDeps();
    const row = await existingItem(deps);
    await setItemCutout(deps, TEST_USER, row.id, named(await cutoutPng()));
    expect((await deps.items.get(TEST_USER, row.id))!.cutout_image_key!.startsWith(`${TEST_USER}/`)).toBe(true);
  });
});

describe("setItemCutout: the item changes during the request", () => {
  it("deleted after the cut-out was stored: not_found and the new file is removed (item had an old cut-out)", async () => {
    const deps = makeTestDeps();
    const row = await existingItem(deps, { cutout: true });
    const setCutoutKey = deps.items.setCutoutKey.bind(deps.items);
    vi.spyOn(deps.items, "setCutoutKey").mockImplementation(async (userId, id, key, madeFrom) => {
      await deleteWardrobeItem(deps, userId, id);
      return setCutoutKey(userId, id, key, madeFrom);
    });
    const error = await rejection(setItemCutout(deps, TEST_USER, row.id, named(await cutoutPng())));
    expect((error as ApiException).code).toBe("not_found");
    expect(deps.storage.objects.size).toBe(0);
  });

  it("the row update itself fails: the error passes on and the new file is removed", async () => {
    const deps = makeTestDeps();
    const row = await existingItem(deps, { cutout: true });
    vi.spyOn(deps.items, "setCutoutKey").mockRejectedValueOnce(new Error("database down"));
    await expect(setItemCutout(deps, TEST_USER, row.id, named(await cutoutPng()))).rejects.toThrow("database down");
    expect(keysIn(deps, STORAGE_BUCKETS.cutouts)).toEqual([row.cutout_image_key]);
  });

  // Was BUG (it.fails, low): the item (and its original) could be deleted
  // between reading the row and downloading the original, which answered
  // 500 internal. Fixed: a failed download re-reads the row.
  it("deleted before its original is read: not_found, not a 500", async () => {
    const deps = makeTestDeps();
    const row = await existingItem(deps);
    const download = deps.storage.download.bind(deps.storage);
    vi.spyOn(deps.storage, "download").mockImplementationOnce(async (bucket, key) => {
      await deleteWardrobeItem(deps, TEST_USER, row.id);
      return download(bucket, key);
    });
    const error = await rejection(setItemCutout(deps, TEST_USER, row.id, named(await cutoutPng())));
    expect(error).toBeInstanceOf(ApiException);
    expect((error as ApiException).code).toBe("not_found");
  });
});

describe("setItemCutout: two uploads racing", () => {
  it("both succeed; the item points at a stored file, the old cut-out is gone, at most one file is orphaned", async () => {
    const deps = makeTestDeps();
    const row = await existingItem(deps, { cutout: true });
    // Make both requests read the row before either writes (the worst order).
    const get = deps.items.get.bind(deps.items);
    let reads = 0;
    let release!: () => void;
    const bothRead = new Promise<void>((resolve) => (release = resolve));
    vi.spyOn(deps.items, "get").mockImplementation(async (...args) => {
      const result = await get(...args);
      if (++reads === 2) release();
      await bothRead;
      return result;
    });

    const [a, b] = await Promise.all([
      setItemCutout(deps, TEST_USER, row.id, named(await cutoutPng({ width: 200, height: 300 }), "a.png")),
      setItemCutout(deps, TEST_USER, row.id, named(await cutoutPng({ width: 300, height: 400 }), "b.png")),
    ]);
    expect(a.cutoutUrl).not.toBeNull();
    expect(b.cutoutUrl).not.toBeNull();

    const after = (await get(TEST_USER, row.id))!;
    await rowFilesExist(deps, after);
    expect(await deps.storage.exists(STORAGE_BUCKETS.cutouts, row.cutout_image_key!)).toBe(false);
    const cutouts = keysIn(deps, STORAGE_BUCKETS.cutouts);
    expect(cutouts).toContain(after.cutout_image_key);
    // The loser's file is left for the orphaned-image cleanup (documented).
    expect(cutouts.length).toBeLessThanOrEqual(2);
  });

  it("ten in a row: one cut-out file left, and it's the item's", async () => {
    const deps = makeTestDeps();
    const row = await existingItem(deps);
    for (let i = 0; i < 10; i++) await setItemCutout(deps, TEST_USER, row.id, named(await cutoutPng()));
    const after = (await deps.items.get(TEST_USER, row.id))!;
    expect(keysIn(deps, STORAGE_BUCKETS.cutouts)).toEqual([after.cutout_image_key]);
  });

  it("the old cut-out can't be deleted: the new one is still saved", async () => {
    const deps = makeTestDeps();
    const row = await existingItem(deps, { cutout: true });
    vi.spyOn(deps.storage, "remove").mockRejectedValueOnce(new Error("storage down"));
    const item = await setItemCutout(deps, TEST_USER, row.id, named(await cutoutPng()));
    expect(item.cutoutUrl).not.toContain(row.cutout_image_key!);
    expect((await deps.items.get(TEST_USER, row.id))!.cutout_image_key).not.toBe(row.cutout_image_key);
  });

  // Was BUG (it.fails, low/medium): a cut-out upload that read the item
  // before a new photo replaced its original still saved the cut-out of the
  // OLD picture. Fixed: setCutoutKey saves only while the original is the
  // one the cut-out was measured against; otherwise not_found, file removed.
  it("a cut-out of the old picture isn't attached after the photo was replaced mid-request", async () => {
    const deps = makeTestDeps();
    // An ordinary item: one still waiting for a photo (needsPhoto) is now refused before any upload.
    const row = await existingItem(deps);
    const upload = deps.storage.upload.bind(deps.storage);
    let replaced = false;
    vi.spyOn(deps.storage, "upload").mockImplementation(async (bucket, key, image) => {
      if (bucket === STORAGE_BUCKETS.cutouts && !replaced) {
        replaced = true;
        await replaceItemPhoto(deps, TEST_USER, row.id, named(await phoneJpeg({ width: 800, height: 600 }), "new.jpg"));
      }
      return upload(bucket, key, image);
    });

    await setItemCutout(deps, TEST_USER, row.id, named(await cutoutPng())).catch(() => null);
    const after = (await deps.items.get(TEST_USER, row.id))!;
    expect(after.original_image_key).not.toBe(row.original_image_key);
    // Either refused, or not attached: the new photo has no cut-out yet.
    expect(after.cutout_image_key).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// PUT /api/items/[id]/photo
// ---------------------------------------------------------------------------

describe("replaceItemPhoto: metadata stripped from every accepted format", () => {
  it.each([
    ["a JPEG with EXIF, GPS, XMP and comment segments", jpegWithEveryMetadataSegment],
    ["a PNG with eXIf, XMP and text chunks", () => pngWithEveryMetadataChunk()],
    ["a WebP with EXIF and XMP chunks", () => webpWithExifAndXmp()],
  ])("%s", async (_label, make) => {
    const deps = makeTestDeps();
    const row = await existingItem(deps, { needsPhoto: true });
    await replaceItemPhoto(deps, TEST_USER, row.id, named(await make()));
    const key = (await deps.items.get(TEST_USER, row.id))!.original_image_key;
    expect(leaksMetadata(deps.storage.get(STORAGE_BUCKETS.originals, key)!.data)).toEqual([]);
  });
});

describe("replaceItemPhoto: files and flags", () => {
  it("deletes exactly the old original and cut-out, and leaves other items' files alone", async () => {
    const deps = makeTestDeps();
    const mine = await existingItem(deps, { needsPhoto: true, cutout: true });
    const other = await existingItem(deps, { cutout: true });
    const theirs = await existingItem(deps, { userId: OTHER_USER, cutout: true });

    await replaceItemPhoto(deps, TEST_USER, mine.id, named(await phoneJpeg()));
    const after = (await deps.items.get(TEST_USER, mine.id))!;

    expect(keysIn(deps, STORAGE_BUCKETS.originals).sort()).toEqual(
      [after.original_image_key, other.original_image_key, theirs.original_image_key].sort(),
    );
    expect(keysIn(deps, STORAGE_BUCKETS.cutouts).sort()).toEqual([other.cutout_image_key, theirs.cutout_image_key].sort());
  });

  it("sets needsPhoto false and needsReview true, keeps the tags and tagsEdited", async () => {
    const deps = makeTestDeps();
    const row = await existingItem(deps, { needsPhoto: true, tagsEdited: true });
    const item = await replaceItemPhoto(deps, TEST_USER, row.id, named(await phoneJpeg()));
    expect(item).toMatchObject({ needsPhoto: false, needsReview: true, tagsEdited: true, tags: tagging.valid, source: "email" });
  });

  it("a second photo replaces the first, and the first is deleted", async () => {
    const deps = makeTestDeps();
    const row = await existingItem(deps, { needsPhoto: true });
    await replaceItemPhoto(deps, TEST_USER, row.id, named(await phoneJpeg()));
    await replaceItemPhoto(deps, TEST_USER, row.id, named(await phoneWebp()));
    const after = (await deps.items.get(TEST_USER, row.id))!;
    expect(after.original_image_key).toMatch(/\.webp$/);
    expect(keysIn(deps, STORAGE_BUCKETS.originals)).toEqual([after.original_image_key]);
  });

  it.each([
    ["a decompression bomb", pngBomb],
    ["a header claiming 60,000 px", pngClaimingHugeDimensions],
    ["a truncated JPEG", async () => truncated(await phoneJpeg({ width: 800, height: 600 }), 0.5)],
  ])("refuses %s on `original`, keeping the placeholder and the needsPhoto flag", async (_label, make) => {
    const deps = makeTestDeps();
    const row = await existingItem(deps, { needsPhoto: true, cutout: true });
    const before = new Set(deps.storage.objects.keys());
    await badRequestOn(replaceItemPhoto(deps, TEST_USER, row.id, named(await make())), "original");
    expect(new Set(deps.storage.objects.keys())).toEqual(before);
    expect(await deps.items.get(TEST_USER, row.id)).toEqual(row);
  });

  it("another user's item: not_found, nothing stored, their files kept", async () => {
    const deps = makeTestDeps();
    const theirs = await existingItem(deps, { userId: OTHER_USER, needsPhoto: true, cutout: true });
    const before = new Set(deps.storage.objects.keys());
    const error = await rejection(replaceItemPhoto(deps, TEST_USER, theirs.id, named(await phoneJpeg())));
    expect((error as ApiException).code).toBe("not_found");
    expect(new Set(deps.storage.objects.keys())).toEqual(before);
  });

  it("the item is deleted mid-request: not_found and the new photo is removed", async () => {
    const deps = makeTestDeps();
    const row = await existingItem(deps, { needsPhoto: true });
    const replaceOriginal = deps.items.replaceOriginal.bind(deps.items);
    vi.spyOn(deps.items, "replaceOriginal").mockImplementation(async (userId, id, key) => {
      await deleteWardrobeItem(deps, userId, id);
      return replaceOriginal(userId, id, key);
    });
    const error = await rejection(replaceItemPhoto(deps, TEST_USER, row.id, named(await phoneJpeg())));
    expect((error as ApiException).code).toBe("not_found");
    expect(deps.storage.objects.size).toBe(0);
  });

  it("two photos racing: the item ends on one of them, which is stored; the placeholder is deleted", async () => {
    const deps = makeTestDeps();
    const row = await existingItem(deps, { needsPhoto: true, cutout: true });
    await Promise.all([
      replaceItemPhoto(deps, TEST_USER, row.id, named(await phoneJpeg(), "a.jpg")),
      replaceItemPhoto(deps, TEST_USER, row.id, named(await phoneWebp(), "b.webp")),
    ]);
    const after = (await deps.items.get(TEST_USER, row.id))!;
    await rowFilesExist(deps, after);
    expect(after.cutout_image_key).toBeNull();
    expect(await deps.storage.exists(STORAGE_BUCKETS.originals, row.original_image_key)).toBe(false);
    expect(keysIn(deps, STORAGE_BUCKETS.cutouts)).toEqual([]);
  });
});
