import { describe, expect, it, vi } from "vitest";
import type { ItemDraft } from "@/contracts";
import { FakeBackgroundRemover } from "@/lib/images";
import { addByPhoto, finishLinkImport, linkFromShare, type AddStage, type PipelineDeps } from "./add-item";

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

const photo = (name: string) => new File(["raw"], name, { type: "image/heic" });

describe("addByPhoto", () => {
  it("prepares, cuts out and uploads, reporting each stage", async () => {
    const d = deps();
    const stages: AddStage[] = [];
    const result = await addByPhoto(photo("IMG_0042.HEIC"), { deps: d, onStage: (s) => stages.push(s) });

    expect(stages).toEqual(["preparing", "cutting_out", "uploading"]);
    expect(result).toEqual({ draft: DRAFT, cutoutFailed: false });
    const upload = vi.mocked(d.uploadPhoto).mock.calls[0]![0];
    // Re-encoded as JPEG, so the name changes too; the cut-out is a PNG.
    expect(upload.original.name).toBe("IMG_0042.jpg");
    expect(upload.cutout?.name).toBe("IMG_0042.png");
    expect(upload.cutout?.blob.type).toBe("image/png");
  });

  it("keeps mock markers in the uploaded file name", async () => {
    const d = deps();
    await addByPhoto(photo("shirt-mock-daily-cap.png"), { deps: d });
    expect(vi.mocked(d.uploadPhoto).mock.calls[0]![0].original.name).toBe("shirt-mock-daily-cap.jpg");
  });

  it("uploads without a cut-out when background removal fails", async () => {
    const d = deps({ remover: new FakeBackgroundRemover({ fail: "out_of_memory" }) });
    const result = await addByPhoto(photo("shirt.jpg"), { deps: d });
    expect(result.cutoutFailed).toBe(true);
    expect(vi.mocked(d.uploadPhoto).mock.calls[0]![0].cutout).toBeNull();
  });

  it("uploads without a cut-out when it can't be shrunk under the size limit", async () => {
    const d = deps({ fitCutout: vi.fn(async () => null) });
    const result = await addByPhoto(photo("shirt.jpg"), { deps: d });
    expect(result.cutoutFailed).toBe(true);
  });

  it("passes the source link for the screenshot fallback", async () => {
    const d = deps();
    await addByPhoto(photo("screenshot.png"), { deps: d, sourceUrl: "https://blocked.example.com/p" });
    expect(vi.mocked(d.uploadPhoto).mock.calls[0]![0].sourceUrl).toBe("https://blocked.example.com/p");
  });

  it("stops before uploading if the photo can't be read", async () => {
    const d = deps({ prepare: vi.fn(async () => Promise.reject(new Error("unreadable"))) });
    await expect(addByPhoto(photo("broken.jpg"), { deps: d })).rejects.toThrow("unreadable");
    expect(d.uploadPhoto).not.toHaveBeenCalled();
  });

  it("lets upload errors through for the screen to show", async () => {
    const d = deps({ uploadPhoto: vi.fn(async () => Promise.reject(new Error("ai_paused"))) });
    await expect(addByPhoto(photo("shirt.jpg"), { deps: d })).rejects.toThrow("ai_paused");
  });
});

describe("finishLinkImport", () => {
  const step1 = { originalImageKey: KEY, originalUrl: "https://storage.example.com/signed/product.jpg" };

  it("cuts out the stored product image and sends the cut-out with the import's key", async () => {
    const d = deps();
    const stages: AddStage[] = [];
    const result = await finishLinkImport(step1, { deps: d, onStage: (s) => stages.push(s) });
    expect(d.fetchImage).toHaveBeenCalledWith(step1.originalUrl);
    expect(stages).toEqual(["cutting_out", "uploading"]);
    const upload = vi.mocked(d.uploadLinkCutout).mock.calls[0]![0];
    expect(upload.originalImageKey).toBe(KEY);
    expect(upload.cutout?.blob.type).toBe("image/png");
    expect(result.cutoutFailed).toBe(false);
  });

  it("still finishes without a cut-out when the product image can't be loaded", async () => {
    const d = deps({ fetchImage: vi.fn(async () => Promise.reject(new Error("expired"))) });
    const result = await finishLinkImport(step1, { deps: d });
    expect(vi.mocked(d.uploadLinkCutout).mock.calls[0]![0].cutout).toBeNull();
    expect(result.cutoutFailed).toBe(true);
  });
});

describe("linkFromShare", () => {
  it("uses the shared url when there is one", () => {
    expect(linkFromShare({ url: "https://shop.example.com/p/1", text: "Look" })).toBe("https://shop.example.com/p/1");
  });

  it("finds the link inside shared text (Android often sends it there)", () => {
    expect(linkFromShare({ text: "Check this out https://shop.example.com/p/1?c=navy great" })).toBe(
      "https://shop.example.com/p/1?c=navy",
    );
  });

  it("is empty when nothing looks like a link", () => {
    expect(linkFromShare({ url: null, text: "no link here" })).toBe("");
    expect(linkFromShare({})).toBe("");
  });
});
