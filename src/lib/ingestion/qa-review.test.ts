/**
 * QA gap tests for batch add and "to review" (CONTRACTS.md section 5,
 * "Several photos at once"; section 11, decision 10): caps reached in the
 * middle of a batch, tagging failures giving a draft, what is counted and
 * given back, and that the review endpoints only see the user's own items.
 *
 * Real images and sharp, in-memory storage and items, a fake tagger with
 * recorded outputs, a real UsageGuard. No network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BatchAddResponseSchema, STORAGE_BUCKETS, type ItemTags } from "@/contracts";
import { ApiException } from "@/lib/api/errors";
import type { PhotoUpload } from "@/lib/api/upload";
import { CapReachedError } from "@/lib/usage/errors";
import { tagging } from "@/test/fixtures/model-output";
import { phoneJpeg } from "@/test/images";
import { OTHER_USER, TEST_USER, makeTestDeps } from "@/test/ingestion-deps";
import { addPhotoForReview } from "./add-photo";
import { createWardrobeItem, listWardrobe, markWardrobeItemsReviewed, saveItemForReview, updateWardrobeItem } from "./wardrobe";

type Deps = ReturnType<typeof makeTestDeps>;
const VALID = tagging.valid as ItemTags;

async function photo(name = "IMG.jpg"): Promise<PhotoUpload> {
  const original = await phoneJpeg({ width: 600, height: 800 });
  return { original: { ...original, name }, cutout: null, sourceUrl: undefined, saveForReview: true };
}

const counted = (deps: Deps) => deps.usageStore.events.filter((e) => e.kind === "item_ingest").length;

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected a failure");
    },
    (e: unknown) => e,
  );
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("batch add: every response matches BatchAddResponseSchema", () => {
  it("saved and draft", async () => {
    const saved = await addPhotoForReview(makeTestDeps({ taggerOutputs: [tagging.valid] }), TEST_USER, await photo());
    const draft = await addPhotoForReview(makeTestDeps({ taggerOutputs: ["nope"] }), TEST_USER, await photo());
    expect(BatchAddResponseSchema.parse(saved).status).toBe("saved");
    expect(BatchAddResponseSchema.parse(draft).status).toBe("draft");
  });
});

describe("batch add: the daily cap reached mid-batch", () => {
  it("two photos at once for the last place today: exactly one saved, the other refused with nothing left behind", async () => {
    const deps = makeTestDeps({ taggerOutputs: [tagging.valid] });
    for (let i = 0; i < 2; i++) await addPhotoForReview(deps, TEST_USER, await photo());

    const results = await Promise.allSettled([addPhotoForReview(deps, TEST_USER, await photo("a.jpg")), addPhotoForReview(deps, TEST_USER, await photo("b.jpg"))]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(CapReachedError);
    expect((rejected[0]!.reason as CapReachedError).toApiException().code).toBe("daily_cap_reached");

    expect(deps.items.rows.size).toBe(3);
    expect(counted(deps)).toBe(3);
    // One original per saved item: the refused photo's file was removed.
    expect(deps.storage.objects.size).toBe(3);
    expect(deps.fakeTagger.calls).toHaveLength(3);
  });

  it("the cap counts other users separately", async () => {
    const deps = makeTestDeps({ taggerOutputs: [tagging.valid] });
    for (let i = 0; i < 3; i++) await addPhotoForReview(deps, TEST_USER, await photo());
    expect((await addPhotoForReview(deps, OTHER_USER, await photo())).status).toBe("saved");
  });

  it("drafts count too: two failed taggings and a saved item use three places", async () => {
    const deps = makeTestDeps({ taggerOutputs: ["bad", "bad", "bad", "bad", tagging.valid] });
    expect((await addPhotoForReview(deps, TEST_USER, await photo())).status).toBe("draft");
    expect((await addPhotoForReview(deps, TEST_USER, await photo())).status).toBe("draft");
    expect((await addPhotoForReview(deps, TEST_USER, await photo())).status).toBe("saved");
    await expect(addPhotoForReview(deps, TEST_USER, await photo())).rejects.toBeInstanceOf(CapReachedError);
  });
});

describe("batch add: AI paused mid-batch", () => {
  it("paused before the next photo: ai_paused before any work, nothing counted or stored", async () => {
    const deps = makeTestDeps({ taggerOutputs: [tagging.valid] });
    expect((await addPhotoForReview(deps, TEST_USER, await photo())).status).toBe("saved");
    await deps.usage.recordAiCost(null, "tagging", 5, "gemini");
    const before = deps.storage.objects.size;

    const error = await rejection(addPhotoForReview(deps, TEST_USER, await photo()));
    expect((error as CapReachedError).toApiException().code).toBe("ai_paused");
    expect(counted(deps)).toBe(1);
    expect(deps.storage.objects.size).toBe(before);
    expect(deps.items.rows.size).toBe(1);
  });

  it("paused between counting and the tagging call: the count is given back, nothing saved, images removed", async () => {
    const deps = makeTestDeps({ taggerOutputs: [tagging.valid] });
    const prepare = deps.images.prepareForModel.bind(deps.images);
    vi.spyOn(deps.images, "prepareForModel").mockImplementation(async (...args) => {
      await deps.usage.recordAiCost(null, "tagging", 5, "gemini");
      return prepare(...args);
    });
    const error = await rejection(addPhotoForReview(deps, TEST_USER, await photo()));
    expect((error as CapReachedError).toApiException().code).toBe("ai_paused");
    expect(counted(deps)).toBe(0);
    expect(deps.items.rows.size).toBe(0);
    expect(deps.storage.objects.size).toBe(0);
    expect(deps.fakeTagger.calls).toHaveLength(0);
  });
});

describe("batch add: tagging fails twice", () => {
  it("returns a draft, saves no row, keeps the image for the draft, counts the item and both tagging attempts", async () => {
    const deps = makeTestDeps({ taggerOutputs: ['{"category":"top","subcategory":"jeans"}', "```json\n{}\n```"] });
    const result = await addPhotoForReview(deps, TEST_USER, await photo());
    expect(result.status).toBe("draft");
    if (result.status !== "draft") return;
    expect(result.draft.suggestedTags).toBeNull();
    expect(deps.items.rows.size).toBe(0);
    expect(await listWardrobe(deps, TEST_USER, { needsReview: true })).toEqual([]);
    expect(await deps.storage.exists(STORAGE_BUCKETS.originals, result.draft.originalImageKey)).toBe(true);
    expect(deps.usageStore.events.map((e) => e.kind).sort()).toEqual(["item_ingest", "tagging", "tagging"]);
  });

  it("the draft can then be saved once with POST /api/items, not counted again, and not 'to review'", async () => {
    const deps = makeTestDeps({ taggerOutputs: ["nope"] });
    const result = await addPhotoForReview(deps, TEST_USER, await photo());
    if (result.status !== "draft") throw new Error("expected a draft");
    const request = {
      source: "photo" as const,
      sourceUrl: null,
      originalImageKey: result.draft.originalImageKey,
      cutoutImageKey: null,
      tags: VALID,
      tagsEdited: true,
    };
    const item = await createWardrobeItem(deps, TEST_USER, request);
    expect(item.needsReview).toBe(false);
    expect(counted(deps)).toBe(1);
    const again = await rejection(createWardrobeItem(deps, TEST_USER, request));
    expect((again as ApiException).code).toBe("bad_request");
  });

  it("the provider throwing twice is a draft too, not a 500", async () => {
    const deps = makeTestDeps();
    vi.spyOn(deps.tagger, "tagItem").mockRejectedValue(new Error("network down"));
    const result = await addPhotoForReview(deps, TEST_USER, await photo());
    expect(result).toMatchObject({ status: "draft", draft: { suggestedTags: null } });
    expect(deps.items.rows.size).toBe(0);
  });
});

describe("batch add: the save fails after tagging", () => {
  it("images removed, nothing listed; the item stays counted because tagging ran (documented)", async () => {
    const deps = makeTestDeps({ taggerOutputs: [tagging.valid] });
    vi.spyOn(deps.items, "create").mockRejectedValueOnce(new Error("database down"));
    await expect(addPhotoForReview(deps, TEST_USER, await photo())).rejects.toThrow("database down");
    expect(deps.storage.objects.size).toBe(0);
    expect(counted(deps)).toBe(1);
  });
});

describe("saveItemForReview", () => {
  it("always saves needsReview true and tagsEdited false, whatever the caller passes", async () => {
    const deps = makeTestDeps();
    const key = `${TEST_USER}/00000000-0000-4000-8000-0000000000dd.jpg`;
    await deps.storage.upload(STORAGE_BUCKETS.originals, key, await phoneJpeg());
    const sneaky = { source: "email", sourceUrl: null, originalImageKey: key, cutoutImageKey: null, tags: VALID, needsReview: false, tagsEdited: true };
    const item = await saveItemForReview(deps, TEST_USER, sneaky as unknown as Parameters<typeof saveItemForReview>[2]);
    expect(item).toMatchObject({ needsReview: true, tagsEdited: false, needsPhoto: false });
  });

  it("a key already used by another item is refused by the unique-key rule", async () => {
    const deps = makeTestDeps();
    const key = `${TEST_USER}/00000000-0000-4000-8000-0000000000ee.jpg`;
    await deps.storage.upload(STORAGE_BUCKETS.originals, key, await phoneJpeg());
    const item = { source: "email" as const, sourceUrl: null, originalImageKey: key, cutoutImageKey: null, tags: VALID };
    await saveItemForReview(deps, TEST_USER, item);
    await expect(saveItemForReview(deps, TEST_USER, item)).rejects.toThrow();
    expect(deps.items.rows.size).toBe(1);
  });
});

describe("review endpoints only see the user's own items", () => {
  async function seed() {
    const deps = makeTestDeps({ taggerOutputs: [tagging.valid] });
    const mine: string[] = [];
    const theirs: string[] = [];
    for (let i = 0; i < 2; i++) {
      const a = await addPhotoForReview(deps, TEST_USER, await photo());
      const b = await addPhotoForReview(deps, OTHER_USER, await photo());
      if (a.status === "saved") mine.push(a.item.id);
      if (b.status === "saved") theirs.push(b.item.id);
    }
    return { deps, mine, theirs };
  }

  it("the needsReview filter lists only the user's items", async () => {
    const { deps, mine, theirs } = await seed();
    expect((await listWardrobe(deps, TEST_USER, { needsReview: true })).map((i) => i.id).sort()).toEqual([...mine].sort());
    expect((await listWardrobe(deps, OTHER_USER, { needsReview: true })).map((i) => i.id).sort()).toEqual([...theirs].sort());
  });

  it("the filter combines with the other filters", async () => {
    const { deps, mine } = await seed();
    await updateWardrobeItem(deps, TEST_USER, mine[0]!, { reviewed: true });
    expect(await listWardrobe(deps, TEST_USER, { needsReview: true, category: VALID.category })).toHaveLength(1);
    expect(await listWardrobe(deps, TEST_USER, { needsReview: true, category: VALID.category === "top" ? "shoes" : "top" })).toEqual([]);
  });

  it("Confirm all with only someone else's IDs: updated 0, their items unchanged", async () => {
    const { deps, theirs } = await seed();
    expect(await markWardrobeItemsReviewed(deps, TEST_USER, theirs)).toBe(0);
    for (const id of theirs) expect((await deps.items.get(OTHER_USER, id))!.needs_review).toBe(true);
  });

  it("Confirm all with a mix: counts only the user's, and changes nothing else about them", async () => {
    const { deps, mine, theirs } = await seed();
    const before = await Promise.all(mine.map((id) => deps.items.get(TEST_USER, id)));
    expect(await markWardrobeItemsReviewed(deps, TEST_USER, [...theirs, ...mine])).toBe(2);
    for (const [i, id] of mine.entries()) {
      expect(await deps.items.get(TEST_USER, id)).toEqual({ ...before[i], needs_review: false });
    }
    expect(await listWardrobe(deps, OTHER_USER, { needsReview: true })).toHaveLength(2);
  });

  it("Confirm all twice: already-reviewed items still count (contract: 'ones already reviewed count too')", async () => {
    const { deps, mine } = await seed();
    expect(await markWardrobeItemsReviewed(deps, TEST_USER, mine)).toBe(2);
    expect(await markWardrobeItemsReviewed(deps, TEST_USER, mine)).toBe(2);
  });

  it("PATCH { reviewed: true } on someone else's item: not_found, and PATCH { tags } doesn't change their tags", async () => {
    const { deps, theirs } = await seed();
    const one = await rejection(updateWardrobeItem(deps, TEST_USER, theirs[0]!, { reviewed: true }));
    expect((one as ApiException).code).toBe("not_found");
    const edited = { ...VALID, description: "Hijacked" };
    const two = await rejection(updateWardrobeItem(deps, TEST_USER, theirs[0]!, { tags: edited }));
    expect((two as ApiException).code).toBe("not_found");
    expect((await deps.items.get(OTHER_USER, theirs[0]!))).toMatchObject({ needs_review: true, description: VALID.description, tags_edited: false });
  });

  it("PATCH { reviewed: true } doesn't touch tags or tagsEdited", async () => {
    const { deps, mine } = await seed();
    const before = (await deps.items.get(TEST_USER, mine[0]!))!;
    await updateWardrobeItem(deps, TEST_USER, mine[0]!, { reviewed: true });
    expect(await deps.items.get(TEST_USER, mine[0]!)).toEqual({ ...before, needs_review: false });
  });
});
