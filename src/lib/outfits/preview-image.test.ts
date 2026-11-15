import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { PREVIEW_STORED_MAX_BYTES } from "@/contracts";
import { encodePreviewForStorage, paddedPortraitSize, storedPortraitSize } from "./preview-image";

async function png(width: number, height: number, background = { r: 240, g: 238, b: 235 }) {
  const buffer = await sharp({ create: { width, height, channels: 3, background } })
    .composite([{ input: { create: { width: Math.floor(width / 2), height: Math.floor(height / 2), channels: 3, background: { r: 20, g: 30, b: 80 } } }, gravity: "center" }])
    .png()
    .withExif({ IFD0: { Make: "Model" } })
    .toBuffer();
  return new Uint8Array(buffer);
}

describe("preview sizes", () => {
  it("pads to the smallest exact 2:3 that holds the picture", () => {
    expect(paddedPortraitSize(832, 1248)).toEqual({ width: 832, height: 1248 });
    expect(paddedPortraitSize(700, 1000)).toEqual({ width: 700, height: 1050 });
    expect(paddedPortraitSize(640, 1000)).toEqual({ width: 668, height: 1002 });
  });

  it("scales to at most 1536 px on the long side, still exactly 2:3", () => {
    expect(storedPortraitSize({ width: 2730, height: 4095 })).toEqual({ width: 1024, height: 1536 });
    expect(storedPortraitSize({ width: 700, height: 1050 })).toEqual({ width: 700, height: 1050 });
  });
});

describe("encodePreviewForStorage", () => {
  it("pads an almost-2:3 picture with its background colour and stores WebP without metadata", async () => {
    const stored = await encodePreviewForStorage(await png(700, 1000));
    expect(stored.mimeType).toBe("image/webp");
    const meta = await sharp(stored.data).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["webp", 700, 1050]);
    expect(meta.exif).toBeUndefined();
    const { data } = await sharp(stored.data).extract({ left: 350, top: 2, width: 1, height: 1 }).raw().toBuffer({ resolveWithObject: true });
    expect(Math.abs(data[0]! - 240)).toBeLessThan(8); // padding, not black
    expect(stored.data.byteLength).toBeLessThanOrEqual(PREVIEW_STORED_MAX_BYTES);
  });

  it("shrinks a large picture to 1024 x 1536", async () => {
    const meta = await sharp((await encodePreviewForStorage(await png(2000, 3000))).data).metadata();
    expect([meta.width, meta.height]).toEqual([1024, 1536]);
  });

  it("flattens a transparent picture onto white, so the padding isn't black", async () => {
    const clear = new Uint8Array(await sharp({ create: { width: 700, height: 1000, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer());
    const stored = await encodePreviewForStorage(clear);
    const { data } = await sharp(stored.data).extract({ left: 350, top: 2, width: 1, height: 1 }).raw().toBuffer({ resolveWithObject: true });
    expect([...data.slice(0, 3)].every((v) => v > 245)).toBe(true);
  });

  it("throws for bytes that don't decode", async () => {
    await expect(encodePreviewForStorage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2]))).rejects.toThrow();
  });
});
