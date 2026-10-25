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
import { MIN_TRANSPARENT_SHARE, SharpImageProcessor, TRANSPARENT_ALPHA_BELOW } from "./sharp-processor";

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

  /** A 100×100 PNG with `seeThrough` pixels at the given alpha, the rest opaque. */
  async function partlyTransparent(seeThrough: number, alpha = 0) {
    const rgba = Buffer.alloc(100 * 100 * 4, 255);
    for (let i = 0; i < seeThrough; i++) rgba[i * 4 + 3] = alpha;
    const png = await sharp(rgba, { raw: { width: 100, height: 100, channels: 4 } }).png().toBuffer();
    return { data: new Uint8Array(png), mimeType: "image/png" as const };
  }

  it("needs at least 1% of pixels see-through (alpha < 250)", async () => {
    expect(MIN_TRANSPARENT_SHARE).toBe(0.01);
    expect(TRANSPARENT_ALPHA_BELOW).toBe(250);
    expect(await processor.hasTransparency(await partlyTransparent(99))).toBe(false); // 0.99%
    expect(await processor.hasTransparency(await partlyTransparent(100))).toBe(true); // exactly 1%
    expect(await processor.hasTransparency(await partlyTransparent(100, 249))).toBe(true);
    expect(await processor.hasTransparency(await partlyTransparent(5000, 250))).toBe(false); // alpha 250 isn't see-through
  });

  it("throws InvalidImageError for a truncated PNG instead of crashing", async () => {
    const png = await cutoutPng();
    const truncated = { data: png.data.slice(0, Math.floor(png.data.byteLength * 0.6)), mimeType: png.mimeType };
    await expect(processor.hasTransparency(truncated)).rejects.toBeInstanceOf(InvalidImageError);
  });
});

describe("inspect checks the magic bytes before decoding", () => {
  it("refuses SVG and TIFF, which libvips could otherwise parse", async () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
    const tiff = new Uint8Array(await sharp({ create: { width: 4, height: 4, channels: 3, background: "#fff" } }).tiff().toBuffer());
    expect(await sharp(tiff).metadata()).toMatchObject({ format: "tiff" }); // libvips reads it…
    for (const data of [svg, tiff]) await expect(processor.inspect(data)).rejects.toBeInstanceOf(InvalidImageError);
  });

  it("reports the upright size of a photo with an EXIF rotation", async () => {
    const info = await processor.inspect((await phoneJpeg({ width: 400, height: 300, orientation: 6 })).data);
    expect([info.width, info.height]).toEqual([300, 400]);
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
