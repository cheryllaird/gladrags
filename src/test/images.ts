/**
 * Real test images, made with sharp at test time (no binary fixtures):
 * phone-like JPEGs with camera and GPS EXIF, transparent PNG cut-outs, and
 * the awkward cases (opaque PNGs, oversized images).
 */
import sharp from "sharp";
import type { ImageInput } from "@/lib/ai/types";

/** A London location, as a phone would write it. */
export const PHONE_EXIF = {
  IFD0: { Make: "TestPhone", Model: "GladRags QA Cam", Software: "TestOS 1.0" },
  IFD3: {
    GPSLatitudeRef: "N",
    GPSLatitude: "51/1 30/1 2604/100",
    GPSLongitudeRef: "W",
    GPSLongitude: "0/1 7/1 3972/100",
  },
};

const toInput = (buffer: Buffer, mimeType: ImageInput["mimeType"]): ImageInput => ({
  data: new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength),
  mimeType,
});

/** A "garment": a navy rectangle on a beige background, like a flat-lay photo. */
function garmentSvg(width: number, height: number): Buffer {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <rect width="100%" height="100%" fill="#c9a77f"/>
      <rect x="${width * 0.25}" y="${height * 0.2}" width="${width * 0.5}" height="${height * 0.6}" fill="#1f2c52"/>
    </svg>`,
  );
}

/** A phone photo: JPEG with camera, GPS and orientation EXIF. Orientation 6 means "rotate 90° clockwise to view". */
export async function phoneJpeg({ width = 400, height = 300, orientation = 1 } = {}): Promise<ImageInput> {
  const buffer = await sharp(garmentSvg(width, height))
    .jpeg({ quality: 90 })
    .withMetadata({ orientation })
    .withExif(PHONE_EXIF)
    .toBuffer();
  return toInput(buffer, "image/jpeg");
}

export async function phonePng({ width = 400, height = 300 } = {}): Promise<ImageInput> {
  const buffer = await sharp(garmentSvg(width, height)).png().withExif(PHONE_EXIF).toBuffer();
  return toInput(buffer, "image/png");
}

export async function phoneWebp({ width = 400, height = 300 } = {}): Promise<ImageInput> {
  const buffer = await sharp(garmentSvg(width, height)).webp().withExif(PHONE_EXIF).toBuffer();
  return toInput(buffer, "image/webp");
}

/** A cut-out: the garment on a transparent background, with EXIF too (it shouldn't survive). */
export async function cutoutPng({ width = 200, height = 300 } = {}): Promise<ImageInput> {
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <rect x="${width * 0.1}" y="${height * 0.1}" width="${width * 0.8}" height="${height * 0.8}" fill="#1f2c52"/>
    </svg>`,
  );
  const buffer = await sharp(svg).ensureAlpha().png().withExif(PHONE_EXIF).toBuffer();
  return toInput(buffer, "image/png");
}

/** A PNG with an alpha channel where every pixel is opaque: not a real cut-out. */
export async function opaquePngWithAlpha({ width = 200, height = 300 } = {}): Promise<ImageInput> {
  const buffer = await sharp({ create: { width, height, channels: 4, background: { r: 30, g: 40, b: 80, alpha: 1 } } })
    .png()
    .toBuffer();
  return toInput(buffer, "image/png");
}

/** A PNG with no alpha channel at all. */
export async function rgbPng({ width = 200, height = 300 } = {}): Promise<ImageInput> {
  const buffer = await sharp({ create: { width, height, channels: 3, background: "#1f2c52" } }).png().toBuffer();
  return toInput(buffer, "image/png");
}

export function asFile(image: ImageInput, name: string): File {
  return new File([image.data.slice()], name, { type: image.mimeType });
}

// ---------------------------------------------------------------------------
// Reading metadata back, independently of the code under test
// ---------------------------------------------------------------------------

/** Tags of interest in an EXIF (TIFF) block's first IFD. */
const GPS_IFD_POINTER = 0x8825;
const MAKE = 0x010f;

/**
 * Parse a raw EXIF block (as sharp's metadata().exif returns it) and list
 * the IFD0 tag numbers. Enough to tell whether GPS data or the camera make
 * is present.
 */
export function exifIfd0Tags(exif: Buffer): number[] {
  // sharp returns the block with the "Exif\0\0" header.
  const start = exif.subarray(0, 6).toString("latin1") === "Exif\0\0" ? 6 : 0;
  const tiff = exif.subarray(start);
  const little = tiff.subarray(0, 2).toString("latin1") === "II";
  const u16 = (o: number) => (little ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
  const u32 = (o: number) => (little ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));
  const ifd0 = u32(4);
  const count = u16(ifd0);
  return Array.from({ length: count }, (_, i) => u16(ifd0 + 2 + i * 12));
}

export const EXIF_TAGS = { GPS_IFD_POINTER, MAKE };

/** Everything sharp can see of an image's metadata, plus whether its raw bytes still mention the camera. */
export async function readMetadata(image: ImageInput) {
  const meta = await sharp(image.data).metadata();
  const bytes = Buffer.from(image.data);
  return {
    format: meta.format,
    width: meta.width,
    height: meta.height,
    hasAlpha: meta.hasAlpha,
    orientation: meta.orientation,
    exif: meta.exif,
    xmp: meta.xmp,
    icc: meta.icc,
    mentionsCamera: bytes.includes("TestPhone") || bytes.includes("GladRags QA Cam"),
  };
}
