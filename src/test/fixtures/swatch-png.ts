/**
 * Tiny solid-colour PNGs, so ranking pass 2 can be recorded and replayed
 * with real image bytes (the mock wardrobe's pictures are SVG, which the
 * model input doesn't accept). Test-only.
 */
import { deflateSync } from "node:zlib";
import type { Colour } from "@/contracts";

export const COLOUR_RGB: Record<Colour, [number, number, number]> = {
  black: [20, 20, 20],
  white: [245, 245, 245],
  cream: [240, 230, 200],
  beige: [215, 195, 160],
  tan: [195, 150, 100],
  brown: [110, 70, 40],
  grey: [140, 140, 140],
  navy: [25, 35, 80],
  blue: [50, 90, 170],
  light_blue: [150, 190, 230],
  teal: [20, 130, 130],
  green: [40, 130, 60],
  olive: [110, 110, 50],
  yellow: [240, 210, 60],
  orange: [235, 130, 40],
  red: [200, 40, 40],
  burgundy: [110, 20, 40],
  pink: [235, 160, 190],
  purple: [110, 60, 150],
  gold: [210, 170, 60],
  silver: [190, 190, 200],
};

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

/** A size × size PNG of one colour. */
export function swatchPng(rgb: [number, number, number], size = 32): Uint8Array {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: RGB
  const row = Buffer.alloc(1 + size * 3);
  for (let x = 0; x < size; x++) row.set(rgb, 1 + x * 3);
  const pixels = Buffer.concat(Array.from({ length: size }, () => row));
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(pixels)),
      chunk("IEND", new Uint8Array()),
    ]),
  );
}
