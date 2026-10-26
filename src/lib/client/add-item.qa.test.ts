// QA tests for the add-item pipelines: background removal failing in every
// way it can, link step 2 fallbacks, the share-target link parsing and the
// resize maths.
import { describe, expect, it, vi } from "vitest";
import { MAX_IMAGE_DIMENSION_PX, type ItemDraft } from "@/contracts";
import { FakeBackgroundRemover, type BackgroundRemover } from "@/lib/images";
import { addByPhoto, finishLinkImport, linkFromShare, type PipelineDeps } from "./add-item";
import { fitWithin } from "./photo";

const KEY = "0a000000-0000-4000-8000-000000000001/1b000000-0000-4000-8000-000000000001.jpg";
const DRAFT: ItemDraft = {
  source: "photo",
  sourceUrl: null,
  originalImageKey: KEY,
  cutoutImageKey: null,
  originalUrl: "/mock/items/uploaded.svg",
  cutoutUrl: null,
  suggestedTags: null,
};

function deps(overrides: Partial<PipelineDeps> = {}): PipelineDeps {
  return {
    prepare: vi.fn(async () => new Blob(["jpeg"], { type: "image/jpeg" })),
    remover: new FakeBackgroundRemover(),
    fitCutout: vi.fn(async (blob: Blob) => blob),
    uploadPhoto: vi.fn(async () => DRAFT),
    uploadLinkCutout: vi.fn(async () => ({ ...DRAFT, source: "link" as const })),
    fetchImage: vi.fn(async () => new Blob(["product"], { type: "image/jpeg" })),
    ...overrides,
  };
}

const photo = (name: string) => new File(["raw"], name, { type: "image/jpeg" });

describe("background removal failing falls back to the original", () => {
  const failures: [string, BackgroundRemover][] = [
    ["throws a plain Error (model failed to load)", { name: "x", removeBackground: async () => Promise.reject(new Error("wasm")) }],
    ["throws a non-Error value", { name: "x", removeBackground: async () => Promise.reject("boom") }],
    ["throws synchronously", { name: "x", removeBackground: () => { throw new Error("sync"); } }],
    ["runs out of memory", new FakeBackgroundRemover({ fail: "out_of_memory" })],
  ];

  it.each(failures)("when the remover %s", async (_label, remover) => {
    const d = deps({ remover });
    const result = await addByPhoto(photo("shirt.jpg"), { deps: d });
    expect(result.cutoutFailed).toBe(true);
    const upload = vi.mocked(d.uploadPhoto).mock.calls[0]![0];
    expect(upload.cutout).toBeNull();
    expect(upload.original.name).toBe("shirt.jpg");
  });

  it("when shrinking the cut-out throws", async () => {
    const d = deps({ fitCutout: vi.fn(async () => Promise.reject(new Error("decode"))) });
    const result = await addByPhoto(photo("shirt.jpg"), { deps: d });
    expect(result.cutoutFailed).toBe(true);
  });

  it("cuts out the resized photo, not the raw file", async () => {
    const prepared = new Blob(["resized"], { type: "image/jpeg" });
    const removeBackground = vi.fn(async () => new Blob(["png"], { type: "image/png" }));
    const d = deps({ prepare: vi.fn(async () => prepared), remover: { name: "spy", removeBackground } });
    await addByPhoto(photo("IMG_1.HEIC"), { deps: d });
    expect(removeBackground).toHaveBeenCalledWith(prepared);
  });

  it("names a nameless camera capture", async () => {
    const d = deps();
    await addByPhoto(new File(["raw"], "", { type: "image/jpeg" }), { deps: d });
    expect(vi.mocked(d.uploadPhoto).mock.calls[0]![0].original.name).toBe("photo.jpg");
  });
});

describe("link step 2", () => {
  const step1 = { originalImageKey: KEY, originalUrl: "https://storage.example.com/signed/product.jpg" };

  it("sends no cut-out when background removal fails on the product image", async () => {
    const d = deps({ remover: new FakeBackgroundRemover({ fail: "out_of_memory" }) });
    const result = await finishLinkImport(step1, { deps: d });
    expect(result.cutoutFailed).toBe(true);
    expect(vi.mocked(d.uploadLinkCutout).mock.calls[0]![0]).toEqual({ originalImageKey: KEY, cutout: null });
  });

  it("lets a step 2 error (an expired import) through for the screen to show", async () => {
    const d = deps({ uploadLinkCutout: vi.fn(async () => Promise.reject(new Error("not_found"))) });
    await expect(finishLinkImport(step1, { deps: d })).rejects.toThrow("not_found");
  });
});

describe("linkFromShare edge cases", () => {
  it("prefers `url`, but falls back to a link inside `text` when `url` isn't a link", () => {
    expect(linkFromShare({ url: "not a link", text: "See https://shop.example.com/p/2" })).toBe("https://shop.example.com/p/2");
  });

  it("ignores links that aren't http or https", () => {
    expect(linkFromShare({ url: "javascript:alert(1)" })).toBe("");
    expect(linkFromShare({ text: "ftp://shop.example.com/p" })).toBe("");
  });

  it("takes the first link when the text has several", () => {
    expect(linkFromShare({ text: "https://a.example.com/1 and https://b.example.com/2" })).toBe("https://a.example.com/1");
  });

  it("accepts upper-case schemes", () => {
    expect(linkFromShare({ url: "HTTPS://SHOP.EXAMPLE.COM/P" })).toBe("HTTPS://SHOP.EXAMPLE.COM/P");
  });
});

describe("fitWithin (resize to 1600 px)", () => {
  it.each([
    ["a very tall photo", 1000, 6000, 267, 1600],
    ["a very wide panorama", 8000, 1000, 1600, 200],
    ["one pixel over", 1601, 1200, 1600, 1199],
    ["exactly 1600 square", 1600, 1600, 1600, 1600],
    ["a tiny image", 16, 9, 16, 9],
    ["a 1 x 1 image", 1, 1, 1, 1],
  ])("%s", (_label, w, h, expectedW, expectedH) => {
    const out = fitWithin(w, h);
    expect(out).toEqual({ width: expectedW, height: expectedH });
    expect(Math.max(out.width, out.height)).toBeLessThanOrEqual(MAX_IMAGE_DIMENSION_PX);
  });

  it("never exceeds 1600 px for any common phone size, after rounding", () => {
    for (const [w, h] of [
      [4032, 3024],
      [4284, 5712],
      [3000, 4000],
      [4000, 2252],
      [2316, 3088],
      [4033, 3025],
    ]) {
      const out = fitWithin(w!, h!);
      expect(Math.max(out.width, out.height)).toBe(1600);
      // Aspect ratio within a pixel of the original.
      expect(Math.abs(out.width / out.height - w! / h!)).toBeLessThan(0.01);
    }
  });
});
