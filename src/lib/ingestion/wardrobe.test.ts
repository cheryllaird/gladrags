/**
 * The wardrobe item logic on in-memory storage and items: saving drafts
 * (ownership, images present, not saved twice), filters and search, tag
 * edits, and deleting items with their images.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STORAGE_BUCKETS, type CreateItemRequest, type ItemTags } from "@/contracts";
import { ApiException } from "@/lib/api/errors";
import { OTHER_USER, TEST_USER, makeTestDeps } from "@/test/ingestion-deps";
import { tagging } from "@/test/fixtures/model-output";
import { cutoutPng, phoneJpeg } from "@/test/images";
import { escapeLikePattern } from "./items-repository";
import { newImageKey } from "./storage";
import {
  createWardrobeItem,
  deleteWardrobeItem,
  getWardrobeItem,
  listWardrobe,
  updateWardrobeItemTags,
  type WardrobeDeps,
} from "./wardrobe";

const CHINOS = tagging.valid as ItemTags;
const TRAINERS: ItemTags = {
  category: "shoes",
  subcategory: "trainers",
  colours: ["white", "green"],
  pattern: "plain",
  formality: 2,
  seasons: ["spring", "summer"],
  warmth: "medium",
  occasions: ["casual", "active"],
  fabric: "leather",
  description: "White 100% leather trainers",
};

async function storeDraftImages(deps: WardrobeDeps, userId = TEST_USER, withCutout = true) {
  const originalImageKey = newImageKey(userId, "image/jpeg");
  await deps.storage.upload(STORAGE_BUCKETS.originals, originalImageKey, await phoneJpeg());
  const cutoutImageKey = withCutout ? newImageKey(userId, "image/png") : null;
  if (cutoutImageKey) await deps.storage.upload(STORAGE_BUCKETS.cutouts, cutoutImageKey, await cutoutPng());
  return { originalImageKey, cutoutImageKey };
}

async function saveItem(deps: WardrobeDeps, tags: ItemTags, options: { userId?: string; withCutout?: boolean } = {}) {
  const keys = await storeDraftImages(deps, options.userId, options.withCutout ?? true);
  const request: CreateItemRequest = { source: "photo", sourceUrl: null, ...keys, tags, tagsEdited: false };
  return createWardrobeItem(deps, options.userId ?? TEST_USER, request);
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
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createWardrobeItem", () => {
  it("saves a draft and returns it with signed URLs", async () => {
    const deps = makeTestDeps();
    const item = await saveItem(deps, CHINOS);
    expect(item).toMatchObject({ source: "photo", sourceUrl: null, tags: CHINOS, tagsEdited: false });
    expect(item.originalUrl).toMatch(/^memory:\/\/originals\//);
    expect(item.cutoutUrl).toMatch(/^memory:\/\/cutouts\//);
  });

  it("refuses images from another user's folder", async () => {
    const deps = makeTestDeps();
    const keys = await storeDraftImages(deps, OTHER_USER);
    const error = await apiError(
      createWardrobeItem(deps, TEST_USER, { source: "photo", sourceUrl: null, ...keys, tags: CHINOS, tagsEdited: false }),
    );
    expect(error.code).toBe("bad_request");
  });

  it("refuses keys that were never uploaded (or were cleaned up)", async () => {
    const deps = makeTestDeps();
    const error = await apiError(
      createWardrobeItem(deps, TEST_USER, {
        source: "photo",
        sourceUrl: null,
        originalImageKey: newImageKey(TEST_USER, "image/jpeg"),
        cutoutImageKey: null,
        tags: CHINOS,
        tagsEdited: false,
      }),
    );
    expect(error.message).toMatch(/expired/);
  });

  it("refuses to save the same draft twice (deleting one would break the other)", async () => {
    const deps = makeTestDeps();
    const keys = await storeDraftImages(deps);
    const request: CreateItemRequest = { source: "photo", sourceUrl: null, ...keys, tags: CHINOS, tagsEdited: false };
    await createWardrobeItem(deps, TEST_USER, request);
    const error = await apiError(createWardrobeItem(deps, TEST_USER, request));
    expect(error.message).toMatch(/already been saved/);
  });
});

describe("listWardrobe", () => {
  it("lists only the user's items, newest first, with filters combined", async () => {
    const deps = makeTestDeps();
    const chinos = await saveItem(deps, CHINOS);
    const trainers = await saveItem(deps, TRAINERS, { withCutout: false });
    await saveItem(deps, CHINOS, { userId: OTHER_USER });

    expect((await listWardrobe(deps, TEST_USER, {})).map((i) => i.id)).toEqual([trainers.id, chinos.id]);
    expect((await listWardrobe(deps, TEST_USER, { category: "shoes" })).map((i) => i.id)).toEqual([trainers.id]);
    expect((await listWardrobe(deps, TEST_USER, { colour: "green" })).map((i) => i.id)).toEqual([trainers.id]);
    expect((await listWardrobe(deps, TEST_USER, { occasion: "work" })).map((i) => i.id)).toEqual([chinos.id]);
    expect((await listWardrobe(deps, TEST_USER, { q: "SLIM" })).map((i) => i.id)).toEqual([chinos.id]);
    expect(await listWardrobe(deps, TEST_USER, { category: "shoes", occasion: "work" })).toEqual([]);
  });

  it("shows the original when there's no cut-out", async () => {
    const deps = makeTestDeps();
    await saveItem(deps, TRAINERS, { withCutout: false });
    const [item] = await listWardrobe(deps, TEST_USER, {});
    expect(item?.cutoutUrl).toBeNull();
  });

  it("leaves out an item whose original image has gone missing, instead of failing the list", async () => {
    const deps = makeTestDeps();
    const kept = await saveItem(deps, CHINOS);
    const broken = await saveItem(deps, TRAINERS);
    const row = await deps.items.get(TEST_USER, broken.id);
    await deps.storage.remove(STORAGE_BUCKETS.originals, [row!.original_image_key]);
    expect((await listWardrobe(deps, TEST_USER, {})).map((i) => i.id)).toEqual([kept.id]);
  });
});

describe("search escaping", () => {
  it("treats % and _ in the search as literal characters", () => {
    expect(escapeLikePattern("100%_cotton\\")).toBe("100\\%\\_cotton\\\\");
  });
});

describe("get, edit and delete", () => {
  it("edits tags and marks them edited", async () => {
    const deps = makeTestDeps();
    const item = await saveItem(deps, CHINOS);
    const edited = await updateWardrobeItemTags(deps, TEST_USER, item.id, { ...CHINOS, colours: ["olive"] });
    expect(edited).toMatchObject({ tagsEdited: true, tags: { colours: ["olive"] } });
    expect((await getWardrobeItem(deps, TEST_USER, item.id)).tagsEdited).toBe(true);
  });

  it("deletes the item and both its images", async () => {
    const deps = makeTestDeps();
    const item = await saveItem(deps, CHINOS);
    const row = (await deps.items.get(TEST_USER, item.id))!;
    await deleteWardrobeItem(deps, TEST_USER, item.id);
    expect(await deps.items.get(TEST_USER, item.id)).toBeNull();
    expect(await deps.storage.exists(STORAGE_BUCKETS.originals, row.original_image_key)).toBe(false);
    expect(await deps.storage.exists(STORAGE_BUCKETS.cutouts, row.cutout_image_key!)).toBe(false);
  });

  it("still deletes the item if removing the images fails", async () => {
    const deps = makeTestDeps();
    const item = await saveItem(deps, CHINOS);
    const storage = Object.create(deps.storage) as typeof deps.storage;
    storage.remove = async () => {
      throw new Error("storage down");
    };
    await deleteWardrobeItem({ ...deps, storage }, TEST_USER, item.id);
    expect(await deps.items.get(TEST_USER, item.id)).toBeNull();
  });

  it("answers not_found for someone else's item, every time", async () => {
    const deps = makeTestDeps();
    const theirs = await saveItem(deps, CHINOS, { userId: OTHER_USER });
    for (const attempt of [
      getWardrobeItem(deps, TEST_USER, theirs.id),
      updateWardrobeItemTags(deps, TEST_USER, theirs.id, TRAINERS),
      deleteWardrobeItem(deps, TEST_USER, theirs.id),
    ]) {
      expect((await apiError(attempt)).code).toBe("not_found");
    }
    expect(await deps.items.get(OTHER_USER, theirs.id)).not.toBeNull();
  });
});
