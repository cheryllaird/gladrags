/**
 * QA gap tests for SharpImageProcessor (spec: Privacy, "Strip EXIF data
 * (including location) from uploads before storing them"; CONTRACTS.md
 * section 5, "Add by photo" steps 2–4).
 *
 * The metadata here is written by hand (src/test/qa-hostile-images.ts), not
 * by sharp, and the checks look at the raw output bytes as well as what
 * sharp reports, so a library default changing can't hide a leak.
 */
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import type { ImageInput } from "@/lib/ai/types";
import {
  GIF_BYTES,
  HOSTILE_SVG,
  animatedWebp,
  apngLike,
  asInput,
  jpegWithEveryMetadataSegment,
  leaksMetadata,
  pngBomb,
  pngClaimingHugeDimensions,
  pngNearlyOpaque,
  pngWithEveryMetadataChunk,
  pngWithOneTransparentPixel,
  truncated,
  webpWithExifAndXmp,
} from "@/test/qa-hostile-images";
import { cutoutPng, phoneJpeg } from "@/test/images";
import { InvalidImageError } from "./server-errors";
import { SharpImageProcessor } from "./sharp-processor";

const images = new SharpImageProcessor();

async function meta(image: ImageInput) {
  return sharp(image.data).metadata();
}

/** RGB of one pixel. */
async function pixel(image: ImageInput, x: number, y: number): Promise<[number, number, number]> {
  const { data, info } = await sharp(image.data).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return [data[i]!, data[i + 1]!, data[i + 2]!];
}

const isNavy = ([r, g, b]: [number, number, number]) => b > r + 30 && b > g + 20 && r < 80;

async function rejects(promise: Promise<unknown>): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(InvalidImageError);
}

describe("the hand-built inputs really carry what must be stripped", () => {
  it.each([
    ["PNG (eXIf, iTXt XMP, tEXt, zTXt)", pngWithEveryMetadataChunk],
    ["JPEG (APP1 EXIF, APP1 XMP, COM)", jpegWithEveryMetadataSegment],
    ["WebP (VP8X with EXIF and XMP chunks)", webpWithExifAndXmp],
  ])("%s", async (_label, make) => {
    const image = await make();
    const m = await meta(image);
    expect(m.exif).toBeDefined();
    expect(m.xmp).toBeDefined();
    expect(m.orientation).toBe(6);
    expect(Buffer.from(image.data).includes("QaSecretCam")).toBe(true);
  });
});

describe("stripMetadata removes EXIF, GPS, XMP and text chunks in every accepted format", () => {
  it.each([
    ["PNG", pngWithEveryMetadataChunk, "png"],
    ["JPEG", jpegWithEveryMetadataSegment, "jpeg"],
    ["WebP", webpWithExifAndXmp, "webp"],
  ] as const)("%s", async (_label, make, format) => {
    const clean = await images.stripMetadata(await make());
    const m = await meta(clean);
    expect(m.format).toBe(format);
    expect(m.exif).toBeUndefined();
    expect(m.xmp).toBeUndefined();
    expect(m.iptc).toBeUndefined();
    expect(m.comments ?? []).toEqual([]);
    expect(m.orientation).toBeUndefined();
    expect(leaksMetadata(clean.data)).toEqual([]);
  });

  it("strips a PNG cut-out's eXIf and XMP chunks and keeps it transparent", async () => {
    const clean = await images.stripMetadata(await pngWithEveryMetadataChunk({ alpha: true }));
    const m = await meta(clean);
    expect(m.hasAlpha).toBe(true);
    expect(leaksMetadata(clean.data)).toEqual([]);
    expect(await images.hasTransparency(clean)).toBe(true);
  });

  it("resize and prepareForModel strip it too (link-import and the tagging image)", async () => {
    for (const make of [pngWithEveryMetadataChunk, jpegWithEveryMetadataSegment, webpWithExifAndXmp]) {
      const image = await make();
      for (const out of [await images.resize(image, 30), await images.prepareForModel(image, 30)]) {
        expect((await meta(out)).exif).toBeUndefined();
        expect(leaksMetadata(out.data)).toEqual([]);
      }
    }
  });
});

describe("orientation is applied to the pixels before the tag is dropped", () => {
  // The marker images are 80 × 40 with a navy block in the top-left quarter.
  // Orientation 6 means "rotate 90° clockwise to view": 40 × 80, navy top-right.
  it.each([
    ["PNG eXIf", pngWithEveryMetadataChunk],
    ["JPEG APP1", jpegWithEveryMetadataSegment],
    ["WebP EXIF chunk", webpWithExifAndXmp],
  ])("%s", async (_label, make) => {
    const clean = await images.stripMetadata(await make());
    const m = await meta(clean);
    expect([m.width, m.height]).toEqual([40, 80]);
    expect(isNavy(await pixel(clean, 35, 5))).toBe(true);
    expect(isNavy(await pixel(clean, 5, 75))).toBe(false);
  });

  it("the model image is upright too", async () => {
    const out = await images.prepareForModel(await jpegWithEveryMetadataSegment(), 768);
    const m = await meta(out);
    expect([m.width, m.height]).toEqual([40, 80]);
  });

  it("inspect reports the stored (rotated) size consistently with what is stored", async () => {
    // The 1600 px check runs on inspect's numbers, before rotation. Rotation
    // only swaps the sides, so the longest side (what's checked) can't grow.
    const photo = await phoneJpeg({ width: 1600, height: 900, orientation: 6 });
    const info = await images.inspect(photo.data);
    const clean = await images.stripMetadata(photo);
    const m = await meta(clean);
    expect(Math.max(info.width, info.height)).toBe(Math.max(m.width!, m.height!));
  });
});

describe("hostile uploads", () => {
  it("a decompression bomb (100 MP PNG in a small file) is refused before its pixels are decoded", async () => {
    const bomb = await pngBomb();
    expect(bomb.data.byteLength).toBeLessThan(1.5 * 1024 * 1024); // passes the byte limit
    await rejects(images.inspect(bomb.data));
    await rejects(images.stripMetadata(bomb));
    await rejects(images.hasTransparency(bomb));
    await rejects(images.prepareForModel(bomb, 768));
  });

  it("a tiny PNG whose header claims 60,000 × 60,000 is refused", async () => {
    await rejects(images.inspect((await pngClaimingHugeDimensions()).data));
  });

  it("an SVG is refused, even though sharp can render SVG", async () => {
    await rejects(images.inspect(new Uint8Array(HOSTILE_SVG)));
  });

  it("a GIF is refused", async () => {
    await rejects(images.inspect(new Uint8Array(GIF_BYTES)));
  });

  it("inspect reports the real type from the bytes, whatever the caller claimed", async () => {
    const png = await cutoutPng();
    const info = await images.inspect(png.data);
    expect(info.mimeType).toBe("image/png");
    // stripMetadata given the wrong claimed type re-encodes to the claimed
    // type; callers must pass inspect's type (checkUploadedImage does).
    const asJpeg = await images.stripMetadata({ data: png.data, mimeType: "image/jpeg" });
    expect((await meta(asJpeg)).format).toBe("jpeg");
  });

  describe("truncated or corrupt images", () => {
    it.each([
      ["JPEG", () => phoneJpeg({ width: 400, height: 300 })],
      ["PNG cut-out", () => cutoutPng()],
    ])("%s: the header still reads, but every decode step fails with InvalidImageError", async (_label, make) => {
      const broken = truncated(await make());
      // inspect only reads the header, so a truncated file passes it...
      await expect(images.inspect(broken.data)).resolves.toBeDefined();
      // ...and fails as soon as the pixels are needed.
      await rejects(images.stripMetadata(broken));
      await rejects(images.prepareForModel(broken, 768));
    });

    it("hasTransparency on a truncated PNG throws InvalidImageError", async () => {
      await rejects(images.hasTransparency(truncated(await cutoutPng(), 0.6)));
    });

    it("random bytes after a valid signature are refused", async () => {
      const bytes = new Uint8Array(2048);
      bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      for (let i = 8; i < bytes.length; i++) bytes[i] = (i * 2654435761) & 0xff;
      await rejects(images.inspect(bytes));
    });

    it("an empty file is refused", async () => {
      await rejects(images.inspect(new Uint8Array(0)));
    });
  });

  describe("animated images", () => {
    it("an animated WebP becomes its first frame only", async () => {
      const anim = await animatedWebp();
      expect((await sharp(anim.data, { animated: true }).metadata()).pages).toBe(3);
      const info = await images.inspect(anim.data);
      expect([info.width, info.height]).toEqual([30, 30]); // one frame, not a 30 × 90 strip
      const clean = await images.stripMetadata(anim);
      const m = await sharp(clean.data, { animated: true }).metadata();
      expect(m.pages ?? 1).toBe(1);
      expect([m.width, m.height]).toEqual([30, 30]);
      // The first frame (red), allowing for lossy WebP re-encoding.
      const [r, g, b] = await pixel(clean, 15, 15);
      expect(r).toBeGreaterThan(240);
      expect(Math.max(g, b)).toBeLessThan(20);
    });

    it("an APNG-style PNG is read as its default image", async () => {
      const apng = await apngLike();
      const clean = await images.stripMetadata(apng);
      expect(Buffer.from(clean.data).includes("acTL")).toBe(false);
      expect((await meta(clean)).width).toBe(80);
    });
  });

  describe("alpha", () => {
    // Threshold changed by the orchestrator: a cut-out needs at least 1% of
    // its pixels with alpha < 250 (these two used to document "any pixel
    // below 255 counts").
    it("one transparent pixel is not enough to count as a cut-out", async () => {
      expect(await images.hasTransparency(await pngWithOneTransparentPixel())).toBe(false);
    });

    it("alpha 254 everywhere doesn't count as transparent", async () => {
      expect(await images.hasTransparency(await pngNearlyOpaque())).toBe(false);
    });

    it("a JPEG never counts as a cut-out", async () => {
      expect(await images.hasTransparency(await phoneJpeg())).toBe(false);
    });

    it("a WebP with real transparency is still reported (the route then refuses it as a cut-out by type)", async () => {
      const webp = await webpWithExifAndXmp({ alpha: true });
      expect((await images.inspect(webp.data)).mimeType).toBe("image/webp");
      expect(await images.hasTransparency(webp)).toBe(true);
    });
  });
});

describe("prepareForModel never sends transparency or a big image", () => {
  it("flattens onto the plain grey and fits 768 px", async () => {
    const big = asInput(
      await sharp({ create: { width: 1600, height: 400, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
        .png()
        .toBuffer(),
      "image/png",
    );
    const out = await images.prepareForModel(big, 768);
    const m = await meta(out);
    expect(m.format).toBe("jpeg");
    expect(m.hasAlpha).toBe(false);
    expect([m.width, m.height]).toEqual([768, 192]);
    expect(await pixel(out, 10, 10)).toEqual([230, 230, 230]);
  });
});
