/**
 * Hand-built hostile and awkward images for the QA tests. Metadata is
 * written byte by byte (not with sharp's own writers) so the stripping tests
 * don't depend on the library under test to create what it must remove.
 */
import { deflateSync } from "node:zlib";
import sharp from "sharp";
import type { ImageInput } from "@/lib/ai/types";

export const SECRET_MAKE = "QaSecretCam";
export const SECRET_GPS_TEXT = "51.50740,-0.12780";
/** XMP as a phone or editing app writes it, with a location. */
export const XMP_WITH_GPS = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:exif="http://ns.adobe.com/exif/1.0/" xmlns:tiff="http://ns.adobe.com/tiff/1.0/" tiff:Make="${SECRET_MAKE}" exif:GPSLatitude="51,30.434N" exif:GPSLongitude="0,7.662W"/></rdf:RDF></x:xmpmeta>`;

const toInput = (buffer: Buffer, mimeType: ImageInput["mimeType"]): ImageInput => ({
  data: new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength),
  mimeType,
});

/** Words that must never survive stripping, in any form. */
export function leaksMetadata(data: Uint8Array): string[] {
  const bytes = Buffer.from(data);
  return [SECRET_MAKE, SECRET_GPS_TEXT, "GPSLatitude", "xmpmeta", "Exif\0\0"].filter((needle) => bytes.includes(needle));
}

// ---------------------------------------------------------------------------
// EXIF (TIFF) block with camera make, orientation and a GPS IFD
// ---------------------------------------------------------------------------

/** A little-endian TIFF block: IFD0 { Make, Orientation, GPS pointer }, GPS IFD { LatitudeRef, Latitude }. */
export function tiffExif({ orientation = 1 } = {}): Buffer {
  const make = Buffer.from(`${SECRET_MAKE}\0`, "latin1");
  const ifd0 = 8;
  const ifd0Size = 2 + 3 * 12 + 4;
  const makeOffset = ifd0 + ifd0Size;
  const gpsOffset = makeOffset + make.length;
  const gpsSize = 2 + 2 * 12 + 4;
  const latitudeOffset = gpsOffset + gpsSize;
  const b = Buffer.alloc(latitudeOffset + 24);
  b.write("II", 0, "latin1");
  b.writeUInt16LE(42, 2);
  b.writeUInt32LE(ifd0, 4);
  let o = ifd0;
  b.writeUInt16LE(3, o);
  o += 2;
  const entry = (tag: number, type: number, count: number, write: (at: number) => void) => {
    b.writeUInt16LE(tag, o);
    b.writeUInt16LE(type, o + 2);
    b.writeUInt32LE(count, o + 4);
    write(o + 8);
    o += 12;
  };
  entry(0x010f, 2, make.length, (at) => b.writeUInt32LE(makeOffset, at));
  entry(0x0112, 3, 1, (at) => b.writeUInt16LE(orientation, at));
  entry(0x8825, 4, 1, (at) => b.writeUInt32LE(gpsOffset, at));
  b.writeUInt32LE(0, o);
  make.copy(b, makeOffset);
  o = gpsOffset;
  b.writeUInt16LE(2, o);
  o += 2;
  entry(0x0001, 2, 2, (at) => b.write("N\0", at, "latin1"));
  entry(0x0002, 5, 3, (at) => b.writeUInt32LE(latitudeOffset, at));
  b.writeUInt32LE(0, o);
  [51, 1, 30, 1, 2604, 100].forEach((v, i) => b.writeUInt32LE(v, latitudeOffset + i * 4));
  return b;
}

// ---------------------------------------------------------------------------
// PNG chunks
// ---------------------------------------------------------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const x of bytes) c = CRC_TABLE[(c ^ x) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

const PNG_IHDR_END = 8 + 4 + 4 + 13 + 4;

/** Insert chunks straight after IHDR. */
export function withPngChunks(png: Buffer, chunks: Buffer[]): Buffer {
  return Buffer.concat([png.subarray(0, PNG_IHDR_END), ...chunks, png.subarray(PNG_IHDR_END)]);
}

/** Rewrite IHDR's width and height (fixing its CRC), leaving the pixel data as it was. */
export function withPngDimensions(png: Buffer, width: number, height: number): Buffer {
  const out = Buffer.from(png);
  out.writeUInt32BE(width, 16);
  out.writeUInt32BE(height, 20);
  out.writeUInt32BE(crc32(out.subarray(12, 29)), 29);
  return out;
}

/** A small landscape "garment" PNG: navy block in the top-left quarter, so rotation is visible. */
export async function markerPng({ width = 80, height = 40, alpha = false } = {}): Promise<Buffer> {
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      ${alpha ? "" : `<rect width="100%" height="100%" fill="#c9a77f"/>`}
      <rect x="0" y="0" width="${width / 2}" height="${height / 2}" fill="#1f2c52"/>
    </svg>`,
  );
  const pipeline = sharp(svg);
  return (alpha ? pipeline.ensureAlpha() : pipeline.flatten({ background: "#c9a77f" })).png().toBuffer();
}

/**
 * A PNG carrying EXIF in an eXIf chunk (orientation 6 and GPS), XMP in an
 * iTXt chunk, and a tEXt comment with a location.
 */
export async function pngWithEveryMetadataChunk({ alpha = false } = {}): Promise<ImageInput> {
  const itxt = Buffer.concat([Buffer.from("XML:com.adobe.xmp\0\0\0\0\0", "latin1"), Buffer.from(XMP_WITH_GPS)]);
  const text = Buffer.from(`Comment\0Taken at ${SECRET_GPS_TEXT} on a ${SECRET_MAKE}`, "latin1");
  const ztxt = Buffer.concat([Buffer.from("Location\0\0", "latin1"), deflateSync(Buffer.from(SECRET_GPS_TEXT))]);
  const png = withPngChunks(await markerPng({ alpha }), [
    pngChunk("eXIf", tiffExif({ orientation: 6 })),
    pngChunk("iTXt", itxt),
    pngChunk("tEXt", text),
    pngChunk("zTXt", ztxt),
  ]);
  return toInput(png, "image/png");
}

// ---------------------------------------------------------------------------
// JPEG and WebP
// ---------------------------------------------------------------------------

function jpegSegment(marker: number, payload: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt8(0xff, 0);
  head.writeUInt8(marker, 1);
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}

/** A JPEG with EXIF (APP1, orientation 6, GPS), XMP (APP1) and a COM comment, all inserted by hand after SOI. */
export async function jpegWithEveryMetadataSegment(): Promise<ImageInput> {
  const plain = await sharp(await markerPng()).jpeg({ quality: 90 }).toBuffer();
  const exif = jpegSegment(0xe1, Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiffExif({ orientation: 6 })]));
  const xmp = jpegSegment(0xe1, Buffer.concat([Buffer.from("http://ns.adobe.com/xap/1.0/\0", "latin1"), Buffer.from(XMP_WITH_GPS)]));
  const comment = jpegSegment(0xfe, Buffer.from(`Taken at ${SECRET_GPS_TEXT}`, "latin1"));
  return toInput(Buffer.concat([plain.subarray(0, 2), exif, xmp, comment, plain.subarray(2)]), "image/jpeg");
}

function riffChunk(fourcc: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.write(fourcc, 0, "latin1");
  head.writeUInt32LE(data.length, 4);
  return Buffer.concat([head, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

/**
 * A WebP in the extended (VP8X) format with EXIF (orientation 6, GPS) and
 * XMP chunks, built by hand around sharp's plain VP8 bitstream.
 */
export async function webpWithExifAndXmp({ alpha = false } = {}): Promise<ImageInput> {
  const simple = await sharp(await markerPng({ alpha }))
    .webp({ lossless: true })
    .toBuffer();
  // Collect the image chunks (VP8 / VP8L / ALPH) from the simple file.
  const imageChunks: Buffer[] = [];
  let width = 0;
  let height = 0;
  for (let o = 12; o < simple.length; ) {
    const fourcc = simple.subarray(o, o + 4).toString("latin1");
    const size = simple.readUInt32LE(o + 4);
    const padded = size + (size % 2);
    if (fourcc === "VP8X") {
      width = simple.readUIntLE(o + 8 + 4, 3) + 1;
      height = simple.readUIntLE(o + 8 + 7, 3) + 1;
    } else {
      imageChunks.push(simple.subarray(o, o + 8 + padded));
    }
    o += 8 + padded;
  }
  if (!width) {
    const meta = await sharp(simple).metadata();
    width = meta.width!;
    height = meta.height!;
  }
  const vp8x = Buffer.alloc(10);
  // Flags: ICC 0x20, alpha 0x10, EXIF 0x08, XMP 0x04.
  vp8x.writeUInt8(0x08 | 0x04 | (alpha ? 0x10 : 0), 0);
  vp8x.writeUIntLE(width - 1, 4, 3);
  vp8x.writeUIntLE(height - 1, 7, 3);
  const body = Buffer.concat([
    Buffer.from("WEBP", "latin1"),
    riffChunk("VP8X", vp8x),
    ...imageChunks,
    riffChunk("EXIF", tiffExif({ orientation: 6 })),
    riffChunk("XMP ", Buffer.from(XMP_WITH_GPS)),
  ]);
  const head = Buffer.alloc(8);
  head.write("RIFF", 0, "latin1");
  head.writeUInt32LE(body.length, 4);
  return toInput(Buffer.concat([head, body]), "image/webp");
}

// ---------------------------------------------------------------------------
// Hostile files
// ---------------------------------------------------------------------------

/** A real PNG that decodes to 10,000 × 10,000 white pixels (100 MP) from a few hundred KB. */
export async function pngBomb(): Promise<ImageInput> {
  const png = await sharp({ create: { width: 10_000, height: 10_000, channels: 3, background: "#fff" } })
    .png({ compressionLevel: 9 })
    .toBuffer();
  return toInput(png, "image/png");
}

/** A tiny PNG whose header claims 60,000 × 60,000 pixels. */
export async function pngClaimingHugeDimensions(): Promise<ImageInput> {
  return toInput(withPngDimensions(await markerPng(), 60_000, 60_000), "image/png");
}

/** First part of a real image only: the header reads fine, the pixels don't. */
export function truncated(image: ImageInput, keep = 0.5): ImageInput {
  return { data: image.data.slice(0, Math.floor(image.data.byteLength * keep)), mimeType: image.mimeType };
}

/** A 3-frame animated WebP (red, green, blue). */
export async function animatedWebp(): Promise<ImageInput> {
  const frame = (colour: string) =>
    sharp({ create: { width: 30, height: 30, channels: 4, background: colour } })
      .png()
      .toBuffer();
  const frames = [await frame("#ff0000"), await frame("#00ff00"), await frame("#0000ff")];
  const webp = await sharp(frames, { join: { animated: true } })
    .webp({ loop: 0, delay: [100, 100, 100] })
    .toBuffer();
  return toInput(webp, "image/webp");
}

/** An APNG: a normal PNG plus an acTL chunk saying it has 2 frames (only the default image is real). */
export async function apngLike(): Promise<ImageInput> {
  const actl = Buffer.alloc(8);
  actl.writeUInt32BE(2, 0);
  actl.writeUInt32BE(0, 4);
  return toInput(withPngChunks(await markerPng({ alpha: true }), [pngChunk("acTL", actl)]), "image/png");
}

/** An SVG with a script and an external reference: must never be accepted. */
export const HOSTILE_SVG = Buffer.from(
  `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="100" height="100"><script>alert(1)</script><image xlink:href="http://169.254.169.254/latest/meta-data/" width="100" height="100"/><rect width="100" height="100" fill="red"/></svg>`,
);

export const GIF_BYTES = Buffer.from("R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==", "base64");

/** A PNG with an alpha channel where only one pixel is see-through. */
export async function pngWithOneTransparentPixel(): Promise<ImageInput> {
  const width = 20;
  const height = 20;
  const raw = Buffer.alloc(width * height * 4, 255);
  raw[3] = 0; // pixel (0, 0) fully transparent
  const png = await sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer();
  return toInput(png, "image/png");
}

/** A PNG with alpha where every pixel is almost-but-not-quite opaque (alpha 254). */
export async function pngNearlyOpaque(): Promise<ImageInput> {
  const png = await sharp({ create: { width: 20, height: 20, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 254 / 255 } } })
    .png()
    .toBuffer();
  return toInput(png, "image/png");
}

export const asInput = toInput;
