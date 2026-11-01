// QA tests for the add-item pipelines: no cut-out while adding, link step 2,
// the share-target link parsing and the resize maths.
import { describe, expect, it, vi } from "vitest";
import { MAX_IMAGE_DIMENSION_PX, type ItemDraft } from "@/contracts";
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
    uploadPhoto: vi.fn(async () => DRAFT),
    uploadPhotoForReview: vi.fn(async () => ({ status: "draft" as const, draft: DRAFT })),
    importLink: vi.fn(async () => Promise.reject(new Error("unused"))),
    finishLink: vi.fn(async () => ({ ...DRAFT, source: "link" as const })),
    finishLinkForReview: vi.fn(async () => ({ status: "draft" as const, draft: DRAFT })),
    ...overrides,
  };
}

const photo = (name: string) => new File(["raw"], name, { type: "image/jpeg" });

describe("adding no longer cuts the item out (milestone 5)", () => {
  it("uploads the resized photo itself, with nothing else", async () => {
    const prepared = new Blob(["resized"], { type: "image/jpeg" });
    const d = deps({ prepare: vi.fn(async () => prepared) });
    await addByPhoto(photo("IMG_1.HEIC"), { deps: d });
    expect(vi.mocked(d.uploadPhoto).mock.calls[0]![0]).toEqual({ original: { blob: prepared, name: "IMG_1.jpg" }, sourceUrl: undefined });
  });

  it("names a nameless camera capture", async () => {
    const d = deps();
    await addByPhoto(new File(["raw"], "", { type: "image/jpeg" }), { deps: d });
    expect(vi.mocked(d.uploadPhoto).mock.calls[0]![0].original.name).toBe("photo.jpg");
  });
});

describe("link step 2", () => {
  const step1 = { originalImageKey: KEY, originalUrl: "https://storage.example.com/signed/product.jpg" };

  it("never downloads the product image on the phone", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const d = deps();
    await finishLinkImport(step1, { deps: d });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(d.finishLink).toHaveBeenCalledWith(KEY);
    fetchSpy.mockRestore();
  });

  it("lets a step 2 error (an expired import) through for the screen to show", async () => {
    const d = deps({ finishLink: vi.fn(async () => Promise.reject(new Error("not_found"))) });
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
