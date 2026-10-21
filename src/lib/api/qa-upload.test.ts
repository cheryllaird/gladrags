/**
 * QA gap tests for upload validation (CONTRACTS.md section 5, "Add by
 * photo"): type sniffing from bytes, byte and pixel limits at the boundary,
 * and the optional cut-out.
 */
import { describe, expect, it } from "vitest";
import { MAX_CUTOUT_BYTES, MAX_IMAGE_DIMENSION_PX, MAX_ORIGINAL_BYTES } from "@/contracts";
import { ANY_ACCEPTED_TYPE, checkImage, sniffImageType } from "@/lib/images/server";
import { ApiException } from "./errors";
import { parseLinkCutoutUpload, parsePhotoUpload } from "./upload";

const JPEG = [0xff, 0xd8, 0xff, 0xe0];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const WEBP = [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50];
const GIF = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61];
const HEIC = [0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]; // ....ftypheic
const PDF = [0x25, 0x50, 0x44, 0x46];

function file(magic: number[], size: number, name = "f", type = "application/octet-stream"): File {
  const bytes = new Uint8Array(Math.max(size, magic.length));
  bytes.set(magic);
  return new File([bytes], name, { type });
}

function form(fields: Record<string, File | string>): Request {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  return new Request("http://localhost/api/items/photo", { method: "POST", body });
}

async function badRequest(promise: Promise<unknown>): Promise<ApiException> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiException) {
      expect(error.code).toBe("bad_request");
      return error;
    }
    throw error;
  }
  throw new Error("expected a bad_request ApiException");
}

const USER = "0a000000-0000-4000-8000-000000000001";
const ORIGINAL_KEY = `${USER}/1a000000-0000-4000-8000-000000000099.jpg`;
const META = { sourceUrl: "https://shop.example.com/p/1", originalImageKey: ORIGINAL_KEY, product: { title: null, brand: null, colour: null } };

describe("sniffImageType edge cases", () => {
  it.each([
    ["a truncated PNG signature", PNG.slice(0, 7)],
    ["a 2-byte JPEG start", JPEG.slice(0, 2)],
    ["RIFF without WEBP", WEBP.slice(0, 8)],
    ["HEIC (iPhone default) - must be converted on the phone", HEIC],
    ["GIF", GIF],
    ["PDF", PDF],
    ["a JPEG signature not at offset 0", [0, ...JPEG]],
  ])("rejects %s", (_label, sig) => {
    expect(sniffImageType(Uint8Array.from(sig))).toBeNull();
  });
});

describe("checkImage at the limits", () => {
  const original = { allowedTypes: ANY_ACCEPTED_TYPE, maxBytes: MAX_ORIGINAL_BYTES };
  const ok = { mimeType: "image/jpeg" as const, width: 1200, height: 900, bytes: 500_000 };

  it("accepts exactly 1600 px on the longest side, either orientation", () => {
    expect(MAX_IMAGE_DIMENSION_PX).toBe(1600);
    expect(checkImage({ ...ok, width: 1600, height: 1200 }, original)).toBeNull();
    expect(checkImage({ ...ok, width: 1200, height: 1600 }, original)).toBeNull();
    expect(checkImage({ ...ok, width: 1600, height: 1600 }, original)).toBeNull();
  });

  it("rejects 1601 px in either dimension", () => {
    expect(checkImage({ ...ok, width: 1601, height: 10 }, original)).toMatch(/1600 px/);
    expect(checkImage({ ...ok, width: 10, height: 1601 }, original)).toMatch(/1600 px/);
  });

  it("accepts exactly the byte limit and rejects one byte over", () => {
    expect(checkImage({ ...ok, bytes: MAX_ORIGINAL_BYTES }, original)).toBeNull();
    expect(checkImage({ ...ok, bytes: MAX_ORIGINAL_BYTES + 1 }, original)).toMatch(/1\.5 MB/);
  });

  it("honours a custom maxDimensionPx (e.g. 256 px thumbnails)", () => {
    expect(checkImage({ ...ok, width: 257, height: 100 }, { ...original, maxDimensionPx: 256 })).toMatch(/256 px/);
  });

  it("rejects zero-height images", () => {
    expect(checkImage({ ...ok, width: 10, height: 0 }, original)).toMatch(/empty/);
  });
});

describe("parsePhotoUpload", () => {
  it.each([
    ["JPEG", JPEG, "image/jpeg"],
    ["PNG", PNG, "image/png"],
    ["WebP", WEBP, "image/webp"],
  ])("accepts a %s original and reports its sniffed type", async (_label, magic, type) => {
    const upload = await parsePhotoUpload(form({ original: file(magic, 64) }));
    expect(upload.original.mimeType).toBe(type);
    expect(upload.cutout).toBeNull();
    expect(upload.sourceUrl).toBeUndefined();
  });

  it("trusts the bytes, not the declared type or name", async () => {
    const pngNamedJpeg = file(PNG, 64, "photo.jpg", "image/jpeg");
    expect((await parsePhotoUpload(form({ original: pngNamedJpeg }))).original.mimeType).toBe("image/png");
    const gifNamedPng = file(GIF, 64, "photo.png", "image/png");
    await badRequest(parsePhotoUpload(form({ original: gifNamedPng })));
  });

  it("accepts an original of exactly 1.5 MB and a cut-out of exactly 2.5 MB", async () => {
    const upload = await parsePhotoUpload(form({ original: file(JPEG, MAX_ORIGINAL_BYTES), cutout: file(PNG, MAX_CUTOUT_BYTES) }));
    expect(upload.original.data.byteLength).toBe(MAX_ORIGINAL_BYTES);
    expect(upload.cutout?.data.byteLength).toBe(MAX_CUTOUT_BYTES);
  });

  it("accepts a missing cut-out, and an empty cut-out file as missing", async () => {
    expect((await parsePhotoUpload(form({ original: file(JPEG, 64) }))).cutout).toBeNull();
    const emptyCutout = new File([], "cutout.png", { type: "image/png" });
    expect((await parsePhotoUpload(form({ original: file(JPEG, 64), cutout: emptyCutout }))).cutout).toBeNull();
  });

  it("rejects an empty original file as missing", async () => {
    const error = await badRequest(parsePhotoUpload(form({ original: new File([], "photo.jpg", { type: "image/jpeg" }) })));
    expect(error.extras.issues).toEqual([{ path: "original", message: "Missing file" }]);
  });

  it.each([
    ["WebP", WEBP],
    ["JPEG", JPEG],
  ])("rejects a %s cut-out (must be PNG for transparency)", async (_label, magic) => {
    const error = await badRequest(parsePhotoUpload(form({ original: file(JPEG, 64), cutout: file(magic, 64) })));
    expect(error.extras.issues?.[0]?.path).toBe("cutout");
  });

  it("rejects text sent in the file fields", async () => {
    const a = await badRequest(parsePhotoUpload(form({ original: "not a file" })));
    expect(a.extras.issues?.[0]).toEqual({ path: "original", message: "Not a file" });
    const b = await badRequest(parsePhotoUpload(form({ original: file(JPEG, 64), cutout: "data:image/png;base64,AAAA" })));
    expect(b.extras.issues?.[0]?.path).toBe("cutout");
  });

  it("names the field and limit when a file is too large", async () => {
    const error = await badRequest(parsePhotoUpload(form({ original: file(JPEG, MAX_ORIGINAL_BYTES + 1) })));
    expect(error.extras.issues).toEqual([{ path: "original", message: "Must be under 1.5 MB" }]);
  });

  it("rejects a JSON body with a clear message", async () => {
    const request = new Request("http://localhost/api/items/photo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ original: "x" }),
    });
    const error = await badRequest(parsePhotoUpload(request));
    expect(error.message).toMatch(/multipart/);
  });

  it("treats an empty sourceUrl as no link, and rejects non-http links", async () => {
    expect((await parsePhotoUpload(form({ original: file(JPEG, 64), sourceUrl: "" }))).sourceUrl).toBeUndefined();
    for (const bad of ["ftp://shop.example.com/p", "data:text/html,hi", "shop.example.com/p"]) {
      await badRequest(parsePhotoUpload(form({ original: file(JPEG, 64), sourceUrl: bad })));
    }
    const ok = await parsePhotoUpload(form({ original: file(JPEG, 64), sourceUrl: "https://shop.example.com/p/1" }));
    expect(ok.sourceUrl).toBe("https://shop.example.com/p/1");
  });

  it("rejects a sourceUrl over 2048 characters", async () => {
    const long = `https://shop.example.com/${"a".repeat(2048)}`;
    await badRequest(parsePhotoUpload(form({ original: file(JPEG, 64), sourceUrl: long })));
  });
});

describe("parseLinkCutoutUpload", () => {
  it("accepts meta without a cut-out", async () => {
    const upload = await parseLinkCutoutUpload(form({ meta: JSON.stringify(META) }));
    expect(upload.cutout).toBeNull();
    expect(upload.meta.originalImageKey).toBe(ORIGINAL_KEY);
  });

  it.each([
    ["missing meta", {}],
    ["meta that isn't JSON", { meta: "{not json" }],
    ["meta as a file", { meta: file([0x7b], 2, "meta.json", "application/json") }],
    ["meta with a non-http sourceUrl", { meta: JSON.stringify({ ...META, sourceUrl: "javascript:alert(1)" }) }],
    ["meta with a path-traversal key", { meta: JSON.stringify({ ...META, originalImageKey: `${USER}/../x.jpg` }) }],
    ["meta with product missing", { meta: JSON.stringify({ sourceUrl: META.sourceUrl, originalImageKey: ORIGINAL_KEY }) }],
  ])("rejects %s", async (_label, fields) => {
    await badRequest(parseLinkCutoutUpload(form(fields as Record<string, string | File>)));
  });

  it("prefixes meta issue paths with 'meta.'", async () => {
    const error = await badRequest(parseLinkCutoutUpload(form({ meta: JSON.stringify({ ...META, sourceUrl: "nope" }) })));
    expect(error.extras.issues?.map((i) => i.path)).toContain("meta.sourceUrl");
  });

  it("applies the PNG and size rules to the cut-out", async () => {
    await badRequest(parseLinkCutoutUpload(form({ meta: JSON.stringify(META), cutout: file(JPEG, 64) })));
    await badRequest(parseLinkCutoutUpload(form({ meta: JSON.stringify(META), cutout: file(PNG, MAX_CUTOUT_BYTES + 1) })));
    const ok = await parseLinkCutoutUpload(form({ meta: JSON.stringify(META), cutout: file(PNG, 64) }));
    expect(ok.cutout?.mimeType).toBe("image/png");
  });
});
