/**
 * The picture stored for an order-email item that came without a usable
 * one (CONTRACTS.md section 2, items.original_image_key; decision 11 in
 * section 11): a plain light grey square with a coat hanger outline, so
 * every item still has an original and nothing else needs a special case.
 * `needsPhoto` tells the UI to ask for a real photo.
 *
 * Each item gets its own copy (image keys are unique per item), so
 * deleting one item never breaks another.
 */
import "server-only";
import sharp from "sharp";
import type { ImageInput } from "@/lib/ai/types";

export const PLACEHOLDER_SIZE_PX = 800;

const HANGER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="${PLACEHOLDER_SIZE_PX}" height="${PLACEHOLDER_SIZE_PX}" viewBox="0 0 800 800">
  <rect width="800" height="800" fill="#ececec"/>
  <g fill="none" stroke="#b5b5b5" stroke-width="18" stroke-linecap="round" stroke-linejoin="round">
    <path d="M400 330 v-30 a45 45 0 1 1 45 -45"/>
    <path d="M400 330 L170 470 h460 Z"/>
  </g>
</svg>`;

let cached: Promise<Uint8Array> | null = null;

/** The placeholder as a JPEG. Rendered once per server instance. */
export async function placeholderImage(): Promise<ImageInput> {
  cached ??= sharp(Buffer.from(HANGER_SVG))
    .flatten({ background: "#ececec" })
    .jpeg({ quality: 80 })
    .toBuffer()
    .then((buffer) => new Uint8Array(buffer))
    .catch((error: unknown) => {
      cached = null;
      throw error;
    });
  return { data: await cached, mimeType: "image/jpeg" };
}
