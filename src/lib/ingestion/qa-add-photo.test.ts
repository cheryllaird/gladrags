/**
 * QA gap tests for the add-by-photo pipeline's order (CONTRACTS.md section
 * 5, "Add by photo", server steps 1–7; section 7, cost controls):
 *
 * - an upload that's refused is never counted against the daily cap;
 * - when AI is paused nothing is stored, counted or sent to the model;
 * - images already stored are removed when a later step fails.
 *
 * Known bugs are pinned with it.fails and named "BUG:" so the suite stays
 * green until they're fixed; remove `.fails` when they are.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STORAGE_BUCKETS } from "@/contracts";
import type { ImageInput, ModelCall, TaggingProvider } from "@/lib/ai/types";
import { ApiException } from "@/lib/api/errors";
import type { PhotoUpload, UploadedImage } from "@/lib/api/upload";
import { CapReachedError } from "@/lib/usage/errors";
import { tagging } from "@/test/fixtures/model-output";
import { cutoutPng, phoneJpeg, readMetadata } from "@/test/images";
import { TEST_USER, makeTestDeps } from "@/test/ingestion-deps";
import { animatedWebp, pngBomb, truncated, webpWithExifAndXmp } from "@/test/qa-hostile-images";
import { addItemFromPhoto } from "./add-photo";

type Deps = ReturnType<typeof makeTestDeps>;

const named = (image: ImageInput, name: string): UploadedImage => ({ ...image, name });

async function upload(overrides: Partial<PhotoUpload> = {}): Promise<PhotoUpload> {
  return {
    original: named(await phoneJpeg({ width: 800, height: 600 }), "IMG_0001.jpg"),
    cutout: named(await cutoutPng(), "cutout.png"),
    sourceUrl: undefined,
    ...overrides,
  };
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected the upload to fail");
    },
    (e: unknown) => e,
  );
}

function nothingKept(deps: Deps) {
  expect(deps.storage.objects.size).toBe(0);
}

function counted(deps: Deps): number {
  return deps.usageStore.events.filter((e) => e.kind === "item_ingest").length;
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a refused upload is never counted against the daily cap", () => {
  it("a decompression bomb original: 400, nothing stored, nothing counted, no model call", async () => {
    const deps = makeTestDeps({ taggerOutputs: [tagging.valid] });
    const error = await failure(addItemFromPhoto(deps, TEST_USER, await upload({ original: named(await pngBomb(), "bomb.png") })));
    expect(error).toBeInstanceOf(ApiException);
    expect((error as ApiException).code).toBe("bad_request");
    expect((error as ApiException).extras.issues?.[0]?.path).toBe("original");
    nothingKept(deps);
    expect(deps.usageStore.events).toEqual([]);
    expect(deps.fakeTagger.calls).toHaveLength(0);
  });

  it("a decompression bomb cut-out: 400 on the cut-out field, nothing counted", async () => {
    const deps = makeTestDeps({ taggerOutputs: [tagging.valid] });
    const error = await failure(addItemFromPhoto(deps, TEST_USER, await upload({ cutout: named(await pngBomb(), "c.png") })));
    expect((error as ApiException).extras.issues?.[0]?.path).toBe("cutout");
    expect(counted(deps)).toBe(0);
  });

  it("a WebP cut-out (even a transparent one) is refused: cut-outs must be PNG", async () => {
    const deps = makeTestDeps({ taggerOutputs: [tagging.valid] });
    const webp = await webpWithExifAndXmp({ alpha: true });
    const error = await failure(addItemFromPhoto(deps, TEST_USER, await upload({ cutout: named(webp, "cutout.png") })));
    expect((error as ApiException).code).toBe("bad_request");
    expect(counted(deps)).toBe(0);
    nothingKept(deps);
  });

  // Was BUG (it.fails): 500 internal, and counted. Fixed: images are fully
  // decoded and cleaned before the item is counted.
  it("a truncated original is a 400 on the original field, nothing stored, not counted", async () => {
    const deps = makeTestDeps({ taggerOutputs: [tagging.valid] });
    const broken = truncated(await phoneJpeg({ width: 800, height: 600 }));
    const error = await failure(addItemFromPhoto(deps, TEST_USER, await upload({ original: named(broken, "IMG.jpg") })));
    expect(counted(deps)).toBe(0);
    expect(error).toBeInstanceOf(ApiException);
    expect((error as ApiException).code).toBe("bad_request");
    expect((error as ApiException).extras.issues?.[0]?.path).toBe("original");
    nothingKept(deps);
    expect(deps.fakeTagger.calls).toHaveLength(0);
  });

  // Was BUG (it.fails): InvalidImageError from hasTransparency, a 500.
  it("a truncated cut-out is a 400 on the cut-out field, nothing stored, not counted", async () => {
    const deps = makeTestDeps({ taggerOutputs: [tagging.valid] });
    const broken = truncated(await cutoutPng(), 0.6);
    const error = await failure(addItemFromPhoto(deps, TEST_USER, await upload({ cutout: named(broken, "c.png") })));
    expect(error).toBeInstanceOf(ApiException);
    expect((error as ApiException).extras.issues?.[0]?.path).toBe("cutout");
    expect(counted(deps)).toBe(0);
    nothingKept(deps);
  });
});

describe("AI paused: nothing is stored, counted or sent", () => {
  it("at exactly the monthly cap, refuses with ai_paused before reading the images", async () => {
    const deps = makeTestDeps({ taggerOutputs: [tagging.valid] });
    await deps.usage.recordAiCost(null, "tagging", 1, "gemini"); // the test cap is 1p
    const before = deps.usageStore.events.length;
    const inspect = vi.spyOn(deps.images, "inspect");
    const error = await failure(addItemFromPhoto(deps, TEST_USER, await upload()));
    expect(error).toBeInstanceOf(CapReachedError);
    expect((error as CapReachedError).toApiException().code).toBe("ai_paused");
    expect(inspect).not.toHaveBeenCalled();
    expect(deps.usageStore.events).toHaveLength(before);
    expect(deps.fakeTagger.calls).toHaveLength(0);
    nothingKept(deps);
  });

  it("just under the cap still works (the cap is reached, not approached)", async () => {
    const deps = makeTestDeps({ taggerOutputs: [tagging.valid] });
    await deps.usage.recordAiCost(null, "tagging", 0.9999, "gemini");
    const draft = await addItemFromPhoto(deps, TEST_USER, await upload());
    expect(draft.suggestedTags).toEqual(tagging.valid);
  });

  it("a paused month and a used-up day together answer ai_paused (AI is checked first)", async () => {
    const deps = makeTestDeps({ taggerOutputs: [tagging.valid] });
    for (let i = 0; i < 3; i++) await deps.usage.reserveAction(TEST_USER, "item_ingest");
    await deps.usage.recordAiCost(null, "tagging", 5, "gemini");
    const error = await failure(addItemFromPhoto(deps, TEST_USER, await upload()));
    expect((error as CapReachedError).toApiException().code).toBe("ai_paused");
  });
});

describe("stored images are removed when a later step fails", () => {
  it("preparing the model image fails: both images removed, error passed on", async () => {
    const deps = makeTestDeps({ taggerOutputs: [tagging.valid] });
    vi.spyOn(deps.images, "prepareForModel").mockRejectedValue(new Error("vips: out of memory"));
    const error = await failure(addItemFromPhoto(deps, TEST_USER, await upload()));
    expect((error as Error).message).toContain("out of memory");
    nothingKept(deps);
  });

  it("recording the AI cost fails (database down): both images removed, no tags handed out unrecorded", async () => {
    const deps = makeTestDeps({ taggerOutputs: [tagging.valid] });
    vi.spyOn(deps.usage, "settleAiCost").mockRejectedValue(new Error("Couldn't settle usage"));
    await failure(addItemFromPhoto(deps, TEST_USER, await upload()));
    nothingKept(deps);
  });

  it("reserving the AI cost fails (database down): both images removed and the model isn't called", async () => {
    const deps = makeTestDeps({ taggerOutputs: [tagging.valid] });
    vi.spyOn(deps.usage, "reserveAiCost").mockRejectedValue(new Error("Couldn't reserve usage"));
    await failure(addItemFromPhoto(deps, TEST_USER, await upload()));
    nothingKept(deps);
    expect(deps.fakeTagger.calls).toHaveLength(0);
  });

  it("AI paused between the first check and the tagging call: ai_paused, images removed, model not called", async () => {
    const deps = makeTestDeps({ taggerOutputs: [tagging.valid] });
    const prepare = deps.images.prepareForModel.bind(deps.images);
    vi.spyOn(deps.images, "prepareForModel").mockImplementation(async (...args) => {
      await deps.usage.recordAiCost(null, "tagging", 5, "gemini"); // someone else used up the month meanwhile
      return prepare(...args);
    });
    const error = await failure(addItemFromPhoto(deps, TEST_USER, await upload()));
    expect(error).toBeInstanceOf(CapReachedError);
    expect((error as CapReachedError).toApiException().code).toBe("ai_paused");
    nothingKept(deps);
    expect(deps.fakeTagger.calls).toHaveLength(0);
  });

  it("storing the original fails: nothing left behind and the model isn't called", async () => {
    const deps = makeTestDeps({ taggerOutputs: [tagging.valid] });
    vi.spyOn(deps.storage, "upload").mockRejectedValueOnce(new Error("storage down"));
    await failure(addItemFromPhoto(deps, TEST_USER, await upload()));
    nothingKept(deps);
    expect(deps.fakeTagger.calls).toHaveLength(0);
  });

  it("a provider that throws an unexpected non-Error value still falls back to empty tags, images kept", async () => {
    const weird: TaggingProvider = {
      name: "gemini",
      tagItem: vi.fn(async (): Promise<ModelCall> => {
        throw "socket hang up";
      }),
    };
    const deps = makeTestDeps({ tagger: weird });
    const draft = await addItemFromPhoto(deps, TEST_USER, await upload());
    expect(draft.suggestedTags).toBeNull();
    expect(weird.tagItem).toHaveBeenCalledTimes(2);
    expect(await deps.storage.exists(STORAGE_BUCKETS.originals, draft.originalImageKey)).toBe(true);
  });
});

describe("other awkward uploads", () => {
  it("an animated WebP original is stored as a single still frame, without EXIF", async () => {
    const deps = makeTestDeps({ taggerOutputs: [tagging.valid] });
    const draft = await addItemFromPhoto(
      deps,
      TEST_USER,
      await upload({ original: named(await animatedWebp(), "anim.webp"), cutout: null }),
    );
    expect(draft.originalImageKey).toMatch(/\.webp$/);
    const stored = deps.storage.get(STORAGE_BUCKETS.originals, draft.originalImageKey)!;
    const sharp = (await import("sharp")).default;
    const m = await sharp(stored.data, { animated: true }).metadata();
    expect(m.pages ?? 1).toBe(1);
  });

  it("a WebP original with EXIF, XMP and orientation is stored upright and clean", async () => {
    const deps = makeTestDeps({ taggerOutputs: [tagging.valid] });
    const draft = await addItemFromPhoto(
      deps,
      TEST_USER,
      await upload({ original: named(await webpWithExifAndXmp(), "x.webp"), cutout: null }),
    );
    const stored = deps.storage.get(STORAGE_BUCKETS.originals, draft.originalImageKey)!;
    const m = await readMetadata(stored);
    expect(m).toMatchObject({ format: "webp", exif: undefined, xmp: undefined, width: 40, height: 80 });
    expect(Buffer.from(stored.data).includes("QaSecretCam")).toBe(false);
  });

  // Rule changed by the orchestrator: a cut-out can't be larger than the
  // photo it was cut from (this test used to document that it was accepted).
  it("a cut-out larger than the original is a 400 on the cut-out field", async () => {
    const deps = makeTestDeps({ taggerOutputs: [tagging.valid] });
    const error = await failure(
      addItemFromPhoto(
        deps,
        TEST_USER,
        await upload({
          original: named(await phoneJpeg({ width: 200, height: 150 }), "small.jpg"),
          cutout: named(await cutoutPng({ width: 1600, height: 1600 }), "big.png"),
        }),
      ),
    );
    expect((error as ApiException).code).toBe("bad_request");
    expect((error as ApiException).extras.issues?.[0]?.path).toBe("cutout");
    expect(counted(deps)).toBe(0);
    nothingKept(deps);
    expect(deps.fakeTagger.calls).toHaveLength(0);
  });

  it("the stored key's extension follows the real type, not the name the phone sent", async () => {
    const deps = makeTestDeps({ taggerOutputs: [tagging.valid] });
    const png = await cutoutPng();
    const draft = await addItemFromPhoto(deps, TEST_USER, await upload({ original: named(png, "IMG_0001.jpg"), cutout: null }));
    expect(draft.originalImageKey).toMatch(/\.png$/);
  });
});
