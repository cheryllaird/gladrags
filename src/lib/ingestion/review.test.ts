/**
 * Batch add and "to review" (spec: "Reviewing new items"): photos saved
 * straight away with their suggested tags, the review list filter,
 * confirming one item or several, and every tag edit clearing the mark.
 * Real images and sharp, in-memory storage and items, a fake tagger with
 * recorded outputs, a real UsageGuard. No network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STORAGE_BUCKETS, type ItemTags } from "@/contracts";
import { ApiException } from "@/lib/api/errors";
import type { PhotoUpload } from "@/lib/api/upload";
import { CapReachedError } from "@/lib/usage/errors";
import { tagging } from "@/test/fixtures/model-output";
import { OTHER_USER, TEST_USER, makeTestDeps } from "@/test/ingestion-deps";
import { cutoutPng, phoneJpeg } from "@/test/images";
import { addPhotoForReview } from "./add-photo";
import { listWardrobe, markWardrobeItemsReviewed, saveItemForReview, updateWardrobeItem } from "./wardrobe";

async function photo(options: { cutout?: boolean; sourceUrl?: string } = {}): Promise<PhotoUpload> {
  const original = await phoneJpeg({ width: 1200, height: 1600, orientation: 6 });
  const cutout = options.cutout ? await cutoutPng() : null;
  return {
    original: { ...original, name: "IMG_0002.jpg" },
    cutout: cutout ? { ...cutout, name: "cutout.png" } : null,
    sourceUrl: options.sourceUrl,
    saveForReview: true,
  };
}

const VALID = tagging.valid as ItemTags;

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("addPhotoForReview", () => {
  it("saves the photo straight away with its suggested tags, marked to review, tagged from the original", async () => {
    const deps = makeTestDeps({ taggerOutputs: [JSON.stringify(tagging.valid)] });
    const result = await addPhotoForReview(deps, TEST_USER, await photo());

    expect(result.status).toBe("saved");
    if (result.status !== "saved") return;
    expect(result.item).toMatchObject({
      source: "photo",
      sourceUrl: null,
      cutoutUrl: null,
      tags: tagging.valid,
      tagsEdited: false,
      needsReview: true,
      needsPhoto: false,
    });
    // Tagged from the original (no cut-out at add time): fitted to 768 px.
    expect(deps.fakeTagger.calls).toHaveLength(1);
    expect(deps.fakeTagger.calls[0]!.image).not.toBeNull();
    // Counted once, plus the tagging call's cost.
    expect(deps.usageStore.events.map((e) => e.kind)).toEqual(["item_ingest", "tagging"]);
    // It's in the wardrobe and the review list.
    expect((await listWardrobe(deps, TEST_USER, { needsReview: true })).map((i) => i.id)).toEqual([result.item.id]);
  });

  it("keeps the link for a screenshot fallback", async () => {
    const deps = makeTestDeps({ taggerOutputs: [tagging.valid] });
    const result = await addPhotoForReview(deps, TEST_USER, await photo({ sourceUrl: "https://shop.example/p/1" }));
    expect(result).toMatchObject({ status: "saved", item: { source: "link", sourceUrl: "https://shop.example/p/1", needsReview: true } });
  });

  it("still accepts an older client's cut-out and saves it on the item", async () => {
    const deps = makeTestDeps({ taggerOutputs: [tagging.valid] });
    const result = await addPhotoForReview(deps, TEST_USER, await photo({ cutout: true }));
    expect(result.status === "saved" && result.item.cutoutUrl).toBeTruthy();
  });

  it("returns a draft with no tags, and saves nothing, when tagging fails twice", async () => {
    const deps = makeTestDeps({ taggerOutputs: ['{"category":"accessory"}', "not json"] });
    const result = await addPhotoForReview(deps, TEST_USER, await photo());
    expect(result.status).toBe("draft");
    if (result.status !== "draft") return;
    expect(result.draft).toMatchObject({ source: "photo", suggestedTags: null, cutoutImageKey: null });
    expect(deps.items.rows.size).toBe(0);
    // The images stay for the user to save the draft with POST /api/items.
    expect(await deps.storage.exists(STORAGE_BUCKETS.originals, result.draft.originalImageKey)).toBe(true);
    expect(deps.fakeTagger.calls).toHaveLength(2);
  });

  it("removes the stored images when saving the item fails", async () => {
    const deps = makeTestDeps({ taggerOutputs: [tagging.valid] });
    vi.spyOn(deps.items, "create").mockRejectedValueOnce(new Error("database down"));
    await expect(addPhotoForReview(deps, TEST_USER, await photo())).rejects.toThrow("database down");
    expect(deps.storage.objects.size).toBe(0);
  });

  it("stops at the daily item cap: each photo counts, and the next one is refused before any work", async () => {
    const deps = makeTestDeps({ taggerOutputs: [tagging.valid] });
    for (let i = 0; i < 3; i++) expect((await addPhotoForReview(deps, TEST_USER, await photo())).status).toBe("saved");
    await expect(addPhotoForReview(deps, TEST_USER, await photo())).rejects.toBeInstanceOf(CapReachedError);
    expect(deps.items.rows.size).toBe(3);
    expect(deps.fakeTagger.calls).toHaveLength(3);
    expect(deps.storage.objects.size).toBe(3);
  });
});

describe("the review list", () => {
  async function seed() {
    const deps = makeTestDeps({ taggerOutputs: [tagging.valid] });
    const toReview = [];
    for (let i = 0; i < 2; i++) {
      const result = await addPhotoForReview(deps, TEST_USER, await photo());
      if (result.status === "saved") toReview.push(result.item.id);
    }
    const reviewed = await deps.items.create(TEST_USER, {
      source: "photo",
      sourceUrl: null,
      originalImageKey: `${TEST_USER}/00000000-0000-4000-8000-0000000000aa.jpg`,
      cutoutImageKey: null,
      tags: VALID,
      tagsEdited: false,
    });
    await deps.storage.upload(STORAGE_BUCKETS.originals, reviewed.original_image_key, await phoneJpeg());
    const others = await deps.items.create(OTHER_USER, {
      source: "photo",
      sourceUrl: null,
      originalImageKey: `${OTHER_USER}/00000000-0000-4000-8000-0000000000bb.jpg`,
      cutoutImageKey: null,
      tags: VALID,
      tagsEdited: false,
      needsReview: true,
    });
    return { deps, toReview, reviewedId: reviewed.id, othersId: others.id };
  }

  it("filters on needsReview, and lists everything without the filter", async () => {
    const { deps, toReview, reviewedId } = await seed();
    expect((await listWardrobe(deps, TEST_USER, { needsReview: true })).map((i) => i.id).sort()).toEqual([...toReview].sort());
    expect((await listWardrobe(deps, TEST_USER, { needsReview: false })).map((i) => i.id)).toEqual([reviewedId]);
    expect(await listWardrobe(deps, TEST_USER, {})).toHaveLength(3);
  });

  it("PATCH { reviewed: true } confirms the tags as they are", async () => {
    const { deps, toReview } = await seed();
    const item = await updateWardrobeItem(deps, TEST_USER, toReview[0]!, { reviewed: true });
    expect(item).toMatchObject({ needsReview: false, tagsEdited: false, tags: tagging.valid });
  });

  it("PATCH { tags } also clears the mark, and sets tagsEdited", async () => {
    const { deps, toReview } = await seed();
    const tags = { ...VALID, description: "Corrected description" };
    const item = await updateWardrobeItem(deps, TEST_USER, toReview[0]!, { tags });
    expect(item).toMatchObject({ needsReview: false, tagsEdited: true, tags: { description: "Corrected description" } });
    const both = await updateWardrobeItem(deps, TEST_USER, toReview[1]!, { tags, reviewed: true });
    expect(both).toMatchObject({ needsReview: false, tagsEdited: true });
  });

  it("PATCH on someone else's item is not_found and changes nothing", async () => {
    const { deps, othersId } = await seed();
    const error = await updateWardrobeItem(deps, TEST_USER, othersId, { reviewed: true }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiException);
    expect((error as ApiException).code).toBe("not_found");
    expect((await deps.items.get(OTHER_USER, othersId))!.needs_review).toBe(true);
  });

  it("Confirm all marks the user's items and ignores anyone else's or unknown IDs", async () => {
    const { deps, toReview, reviewedId, othersId } = await seed();
    const updated = await markWardrobeItemsReviewed(deps, TEST_USER, [...toReview, reviewedId, othersId, "1a000000-0000-4000-8000-0000000009ff"]);
    expect(updated).toBe(3); // the two to review, plus the already-reviewed one
    expect(await listWardrobe(deps, TEST_USER, { needsReview: true })).toEqual([]);
    expect((await deps.items.get(OTHER_USER, othersId))!.needs_review).toBe(true);
  });
});

describe("saveItemForReview (for order emails and link batches)", () => {
  it("saves an email item without a picture as to review and needing a photo", async () => {
    const deps = makeTestDeps();
    const key = `${TEST_USER}/00000000-0000-4000-8000-0000000000cc.png`;
    await deps.storage.upload(STORAGE_BUCKETS.originals, key, await cutoutPng());
    const item = await saveItemForReview(deps, TEST_USER, {
      source: "email",
      sourceUrl: "https://www.next.co.uk/p/1",
      originalImageKey: key,
      cutoutImageKey: null,
      tags: VALID,
      needsPhoto: true,
    });
    expect(item).toMatchObject({ source: "email", needsReview: true, needsPhoto: true, tagsEdited: false, cutoutUrl: null });
  });
});
