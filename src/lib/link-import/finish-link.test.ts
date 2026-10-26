/**
 * Add by link, step 2: the cut-out is checked before the import is used
 * up, the import is single-use, the server's stored product data (never
 * the phone's) goes to the tagger as hints, and the item is counted once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ItemDraftSchema, LINK_IMPORT_TTL_SECONDS, STORAGE_BUCKETS, type LinkProduct } from "@/contracts";
import { ApiException } from "@/lib/api/errors";
import type { LinkCutoutUpload } from "@/lib/api/upload";
import { CapReachedError } from "@/lib/usage/errors";
import { tagging } from "@/test/fixtures/model-output";
import { OTHER_USER, TEST_LIMITS, TEST_USER } from "@/test/ingestion-deps";
import { cutoutPng, opaquePngWithAlpha, phoneJpeg, readMetadata } from "@/test/images";
import { finishLinkImport } from "./finish-link";
import { makeLinkDeps, testNetwork } from "./test-support";

const SOURCE_URL = "https://shop.example/p/linen-shirt";
const PRODUCT: LinkProduct = { title: "Relaxed Linen Shirt", brand: "Hartley & Lowe", colour: "Navy/White" };

let deps: ReturnType<typeof makeLinkDeps>;

/** What step 1 leaves behind: a stored original (1200×1600) and an open import. */
async function stepOne(userId = TEST_USER): Promise<string> {
  const key = `${userId}/${crypto.randomUUID()}.jpg`;
  const original = await deps.images.stripMetadata(await phoneJpeg({ width: 1200, height: 1600 }));
  await deps.storage.upload(STORAGE_BUCKETS.originals, key, original);
  await deps.linkImports.create({ userId, sourceUrl: SOURCE_URL, originalImageKey: key, product: PRODUCT });
  return key;
}

async function upload(originalImageKey: string, cutout: "good" | "none" | "too-big" | "opaque" | "corrupt" = "good"): Promise<LinkCutoutUpload> {
  const image =
    cutout === "good"
      ? await cutoutPng({ width: 600, height: 900 })
      : cutout === "too-big"
        ? await cutoutPng({ width: 1300, height: 1700 })
        : cutout === "opaque"
          ? await opaquePngWithAlpha()
          : cutout === "corrupt"
            ? { data: (await cutoutPng()).data.slice(0, 200), mimeType: "image/png" as const }
            : null;
  return {
    meta: { originalImageKey },
    cutout: image ? { data: image.data, mimeType: "image/png", name: "cutout.png" } : null,
  };
}

async function errorOf(promise: Promise<unknown>): Promise<ApiException | CapReachedError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiException || error instanceof CapReachedError) return error;
    throw error;
  }
  throw new Error("expected an error");
}

const itemsUsed = async () => (await deps.usage.summary(TEST_USER)).itemsToday.used;

beforeEach(() => {
  deps = makeLinkDeps(testNetwork(1, {}), { taggerOutputs: [JSON.stringify(tagging.valid)] });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("step 2 succeeds", () => {
  it("stores the cleaned cut-out, tags it with the stored product hints, counts once, returns the draft", async () => {
    const key = await stepOne();
    const draft = ItemDraftSchema.parse(await finishLinkImport(deps, TEST_USER, await upload(key)));

    expect(draft).toMatchObject({ source: "link", sourceUrl: SOURCE_URL, originalImageKey: key, suggestedTags: tagging.valid });
    expect(draft.cutoutImageKey?.startsWith(`${TEST_USER}/`)).toBe(true);
    expect(draft.cutoutUrl).toContain("memory://cutouts/");
    expect(draft.originalUrl).toContain(`memory://originals/${key}`);

    const storedCutout = deps.storage.get(STORAGE_BUCKETS.cutouts, draft.cutoutImageKey!)!;
    const meta = await readMetadata(storedCutout);
    expect(meta.format).toBe("png");
    expect(meta.hasAlpha).toBe(true);
    expect(meta.exif).toBeUndefined();
    expect(meta.mentionsCamera).toBe(false);

    // Hints are the server's copy from step 1.
    expect(deps.fakeTagger.calls).toHaveLength(1);
    expect(deps.fakeTagger.calls[0]!.productHints).toEqual(PRODUCT);
    expect(await itemsUsed()).toBe(1);
  });

  it("with no cut-out, tags the original and returns a null cut-out", async () => {
    const key = await stepOne();
    const draft = await finishLinkImport(deps, TEST_USER, await upload(key, "none"));
    expect(draft.cutoutImageKey).toBeNull();
    expect(draft.cutoutUrl).toBeNull();
    const tagged = deps.fakeTagger.calls[0]!.image;
    expect(tagged.mimeType).toBe("image/jpeg");
  });

  it("a cut-out that isn't see-through is treated as missing, not an error", async () => {
    const key = await stepOne();
    const draft = await finishLinkImport(deps, TEST_USER, await upload(key, "opaque"));
    expect(draft.cutoutImageKey).toBeNull();
    expect(deps.storage.objects.size).toBe(1); // just the original
  });

  it("tagging that fails twice gives empty tags, and the item still counts", async () => {
    deps = makeLinkDeps(testNetwork(1, {}), { taggerOutputs: ["not json", "{}"] });
    const key = await stepOne();
    const draft = await finishLinkImport(deps, TEST_USER, await upload(key));
    expect(draft.suggestedTags).toBeNull();
    expect(deps.fakeTagger.calls).toHaveLength(2);
    expect(await itemsUsed()).toBe(1);
  });
});

describe("a rejected cut-out doesn't use the import up", () => {
  it.each([
    ["larger than the original", "too-big"],
    ["corrupt", "corrupt"],
  ] as const)("%s: 400 on cutout, nothing counted or stored, and a retry works", async (_label, kind) => {
    const key = await stepOne();
    const error = await errorOf(finishLinkImport(deps, TEST_USER, await upload(key, kind)));
    expect(error).toBeInstanceOf(ApiException);
    expect((error as ApiException).code).toBe("bad_request");
    expect((error as ApiException).extras.issues?.[0]?.path).toBe("cutout");
    expect(await itemsUsed()).toBe(0);
    expect(deps.fakeTagger.calls).toHaveLength(0);
    expect(deps.storage.objects.size).toBe(1);

    // The import is still there for a proper cut-out.
    const draft = await finishLinkImport(deps, TEST_USER, await upload(key));
    expect(draft.cutoutImageKey).not.toBeNull();
    expect(await itemsUsed()).toBe(1);
  });
});

describe("single use and ownership", () => {
  it("a second call is not_found, and doesn't tag or count again", async () => {
    const key = await stepOne();
    await finishLinkImport(deps, TEST_USER, await upload(key));
    const error = await errorOf(finishLinkImport(deps, TEST_USER, await upload(key)));
    expect((error as ApiException).code).toBe("not_found");
    expect(deps.fakeTagger.calls).toHaveLength(1);
    expect(await itemsUsed()).toBe(1);
    // The second call's cut-out wasn't left behind.
    expect([...deps.storage.objects.keys()].filter((k) => k.startsWith("cutouts/"))).toHaveLength(1);
  });

  it("two calls at once: exactly one wins", async () => {
    const key = await stepOne();
    const results = await Promise.allSettled([
      finishLinkImport(deps, TEST_USER, await upload(key)),
      finishLinkImport(deps, TEST_USER, await upload(key)),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: "not_found" });
    expect(deps.fakeTagger.calls).toHaveLength(1);
    expect([...deps.storage.objects.keys()].filter((k) => k.startsWith("cutouts/"))).toHaveLength(1);
  });

  it("someone else's import is not_found (even with a key in their folder)", async () => {
    const theirs = await stepOne(OTHER_USER);
    expect(((await errorOf(finishLinkImport(deps, TEST_USER, await upload(theirs)))) as ApiException).code).toBe("not_found");
    // A key in my folder that no import of mine has.
    const unknown = `${TEST_USER}/${crypto.randomUUID()}.jpg`;
    expect(((await errorOf(finishLinkImport(deps, TEST_USER, await upload(unknown)))) as ApiException).code).toBe("not_found");
    expect(deps.fakeTagger.calls).toHaveLength(0);
    // Theirs is untouched.
    expect(await deps.linkImports.findOpen(OTHER_USER, theirs)).not.toBeNull();
  });

  it("an expired import is not_found", async () => {
    const key = await stepOne();
    deps.advance(LINK_IMPORT_TTL_SECONDS * 1000 + 1);
    expect(((await errorOf(finishLinkImport(deps, TEST_USER, await upload(key)))) as ApiException).code).toBe("not_found");
  });

  it("an import whose image is gone is not_found", async () => {
    const key = await stepOne();
    await deps.storage.remove(STORAGE_BUCKETS.originals, [key]);
    expect(((await errorOf(finishLinkImport(deps, TEST_USER, await upload(key)))) as ApiException).code).toBe("not_found");
  });
});

describe("caps", () => {
  it("at today's cap: 429 before anything, and the import stays usable", async () => {
    const key = await stepOne();
    for (let i = 0; i < TEST_LIMITS.dailyCaps.item_ingest; i++) await deps.usage.recordAction(TEST_USER, "item_ingest");
    const error = await errorOf(finishLinkImport(deps, TEST_USER, await upload(key)));
    expect(error).toMatchObject({ cap: "items_per_day" });
    expect(await deps.linkImports.findOpen(TEST_USER, key)).not.toBeNull();
  });

  it("AI paused: 503 before anything", async () => {
    const key = await stepOne();
    await deps.usage.recordAiCost(null, "tagging", TEST_LIMITS.monthlySpendCapPence);
    const error = await errorOf(finishLinkImport(deps, TEST_USER, await upload(key)));
    expect(error).toMatchObject({ cap: "monthly_ai_spend" });
    expect(deps.fakeTagger.calls).toHaveLength(0);
  });
});

describe("failures after claiming", () => {
  it("removes the stored cut-out if tagging blows up", async () => {
    const key = await stepOne();
    vi.spyOn(deps.images, "prepareForModel").mockRejectedValueOnce(new Error("boom"));
    await expect(finishLinkImport(deps, TEST_USER, await upload(key))).rejects.toThrow("boom");
    expect([...deps.storage.objects.keys()].filter((k) => k.startsWith("cutouts/"))).toEqual([]);
    // The original stays for the cleanup job.
    expect(await deps.storage.exists(STORAGE_BUCKETS.originals, key)).toBe(true);
  });
});
