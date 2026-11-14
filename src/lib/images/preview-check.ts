/**
 * Round 2: the facts checkGeneratedPreviewImage needs about a generated
 * image, from a FULL decode (every pixel), not a header read: a truncated
 * or hostile file must fail here. Server only (sharp).
 */
import "server-only";
import sharp from "sharp";
import { PREVIEW_DECODE_MAX_INPUT_PIXELS, PREVIEW_OUTPUT_MAX_BYTES, type GeneratedImageFacts } from "@/contracts";
import { sniffImageType } from "./sniff";

export async function inspectGeneratedImage(data: Uint8Array): Promise<GeneratedImageFacts> {
  const facts: GeneratedImageFacts = { mimeType: sniffImageType(data), byteLength: data.byteLength, dimensions: null };
  // Too big or not a known type: refused by the checks anyway, so don't decode.
  if (data.byteLength === 0 || data.byteLength > PREVIEW_OUTPUT_MAX_BYTES || !facts.mimeType) return facts;
  try {
    const { info } = await sharp(data, { limitInputPixels: PREVIEW_DECODE_MAX_INPUT_PIXELS, failOn: "error" })
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (info.width > 0 && info.height > 0) facts.dimensions = { width: info.width, height: info.height };
  } catch {
    facts.dimensions = null;
  }
  return facts;
}
