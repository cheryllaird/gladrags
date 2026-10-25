/**
 * The sharp-based ServerImageProcessor on real images: EXIF (location
 * included) is stripped from every format, orientation is applied, cut-out
 * transparency survives, and the alpha check tells real cut-outs from
 * opaque PNGs.
 */
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  EXIF_TAGS,
  cutoutPng,
  exifIfd0Tags,
  opaquePngWithAlpha,
  phoneJpeg,
  phonePng,
  phoneWebp,
  readMetadata,
  rgbPng,
} from "@/test/images";
import { InvalidImageError } from "./server";
import { SharpImageProcessor } from "./sharp-processor";

const processor = new SharpImageProcessor();

describe("test images really carry EXIF with a location (so the stripping tests mean something)", () => {
  it.each([
    ["JPEG", phoneJpeg],
    ["PNG", phonePng],
    ["WebP", phoneWebp],
    ["cut-out PNG", cutoutPng],
  ])("%s has camera make and a GPS IFD", async (_label, make) => {
    const meta = await readMetadata(await make());
    expect(meta.exif).toBeDefined();
    const tags = exifIfd0Tags(meta.exif!);
    expect(tags).toContain(EXIF_TAGS.GPS_IFD_POINTER);
    expect(tags).toContain(EXIF_TAGS.MAKE);
    expect(meta.mentionsCamera).toBe(true);
  });
});

describe("stripMetadata", () => {
  it.each([
    ["JPEG", phoneJpeg, "jpeg"],
    ["PNG", phonePng, "png"],
    ["WebP", phoneWebp, "webp"],
  ] as const)("removes all EXIF, XMP and ICC from a %s and keeps the format", async (_label, make, format) => {
    const input = await make();
    const output = await processor.stripMetadata(input);
    const meta = await readMetadata(output);
    expect(output.mimeType).toBe(input.mimeType);
    expect(meta.format).toBe(format);
    expect(meta.exif).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
    expect(meta.icc).toBeUndefined();
    expect(meta.mentionsCamera).toBe(false);
  });

  it("applies the EXIF orientation to the pixels before dropping it", async () => {
    // Stored 400×300 with "rotate 90° to view": the upright photo is 300×400.
    const input = await phoneJpeg({ width: 400, height: 300, orientation: 6 });
    expect((await readMetadata(input)).orientation).toBe(6);
    const meta = await readMetadata(await processor.stripMetadata(input));
    expect(meta.orientation).toBeUndefined();
    expect([meta.width, meta.height]).toEqual([300, 400]);
  });

  it("keeps a cut-out's transparency", async () => {
    const output = await processor.stripMetadata(await cutoutPng());
    expect((await readMetadata(output)).hasAlpha).toBe(true);
    expect(await processor.hasTransparency(output)).toBe(true);
    // A corner pixel is still fully transparent.
    const { data } = await sharp(output.data).raw().toBuffer({ resolveWithObject: true });
    expect(data[3]).toBe(0);
  });
});

describe("inspect", () => {
  it("reads type, size and alpha from the header", async () => {
    const jpeg = await phoneJpeg({ width: 1600, height: 1200 });
    expect(await processor.inspect(jpeg.data)).toEqual({
      mimeType: "image/jpeg",
      width: 1600,
      height: 1200,
      bytes: jpeg.data.byteLength,
      hasAlpha: false,
    });
    expect((await processor.inspect((await cutoutPng()).data)).hasAlpha).toBe(true);
  });

  it("rejects bytes that only look like an image", async () => {
    const fakeJpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
    await expect(processor.inspect(fakeJpeg)).rejects.toBeInstanceOf(InvalidImageError);
  });

  it("rejects formats other than JPEG, PNG and WebP", async () => {
    const gif = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#fff" } }).gif().toBuffer();
    await expect(processor.inspect(new Uint8Array(gif))).rejects.toBeInstanceOf(InvalidImageError);
  });
});

describe("hasTransparency (the cut-out alpha check)", () => {
  it("is true for a cut-out with transparent pixels", async () => {
    expect(await processor.hasTransparency(await cutoutPng())).toBe(true);
  });

  it("is false for a PNG with an alpha channel but no transparent pixels", async () => {
    expect(await processor.hasTransparency(await opaquePngWithAlpha())).toBe(false);
  });

  it("is false for a PNG with no alpha channel", async () => {
    expect(await processor.hasTransparency(await rgbPng())).toBe(false);
  });
});

describe("resize and prepareForModel", () => {
  it("shrinks to fit, never enlarges, and strips EXIF", async () => {
    const big = await processor.resize(await phoneJpeg({ width: 1000, height: 500 }), 256);
    const meta = await readMetadata(big);
    expect([meta.width, meta.height]).toEqual([256, 128]);
    expect(meta.exif).toBeUndefined();
    const small = await readMetadata(await processor.resize(await phoneJpeg({ width: 100, height: 50 }), 256));
    expect([small.width, small.height]).toEqual([100, 50]);
  });

  it("flattens a cut-out onto plain grey as a small JPEG", async () => {
    const prepared = await processor.prepareForModel(await cutoutPng({ width: 1000, height: 1500 }), 768);
    const meta = await readMetadata(prepared);
    expect(prepared.mimeType).toBe("image/jpeg");
    expect(meta.format).toBe("jpeg");
    expect(meta.hasAlpha).toBe(false);
    expect([meta.width, meta.height]).toEqual([512, 768]);
    expect(meta.exif).toBeUndefined();
    const { data } = await sharp(prepared.data).raw().toBuffer({ resolveWithObject: true });
    // Corner: the transparent background became light grey (#e6e6e6), give or take JPEG rounding.
    for (const channel of [data[0], data[1], data[2]]) expect(Math.abs(channel! - 0xe6)).toBeLessThanOrEqual(3);
  });
});
