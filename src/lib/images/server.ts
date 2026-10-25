/**
 * Server-side image checks and processing for the upload routes. The pure
 * checks are here; decoding, EXIF stripping and resizing use sharp, in
 * ./sharp-processor.ts.
 */
import "server-only";
import { ACCEPTED_IMAGE_TYPES, MAX_IMAGE_DIMENSION_PX, type AcceptedImageType } from "@/contracts";
import type { ImageInput } from "@/lib/ai/types";
import { SharpImageProcessor } from "./sharp-processor";

export type { ImageInput };
export { InvalidImageError } from "./server-errors";

/** How long signed image URLs last in wardrobe and outfit responses. Images are private. */
export const SIGNED_URL_TTL_SECONDS = 60 * 60;

/** Thumbnail size sent to the ranking model's second pass (spec: around 256 px). */
export const RANKING_THUMBNAIL_PX = 256;

/**
 * Longest side of the image sent to the tagging model. Big enough to see
 * fabric and pattern, small enough to keep the request cheap and quick.
 */
export const TAGGING_IMAGE_PX = 768;

/**
 * Work out the image type from its first bytes, ignoring what the client
 * claimed. Returns null for anything that isn't JPEG, PNG or WebP.
 */
export function sniffImageType(bytes: Uint8Array): AcceptedImageType | null {
  const starts = (sig: number[], offset = 0) => sig.every((b, i) => bytes[offset + i] === b);
  if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  // "RIFF" .... "WEBP"
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  return null;
}

export interface ImageInfo {
  mimeType: AcceptedImageType;
  width: number;
  height: number;
  bytes: number;
  /** True if the image has an alpha channel (it may still be fully opaque). */
  hasAlpha: boolean;
}

export interface ImageRules {
  allowedTypes: readonly AcceptedImageType[];
  maxBytes: number;
  maxDimensionPx?: number;
}

/** Check an image against the upload rules. Returns a user-facing problem, or null if it's fine. */
export function checkImage(info: Omit<ImageInfo, "hasAlpha">, rules: ImageRules): string | null {
  if (!rules.allowedTypes.includes(info.mimeType)) {
    return `Must be ${rules.allowedTypes.map((t) => t.replace("image/", "").toUpperCase()).join(" or ")}`;
  }
  if (info.bytes > rules.maxBytes) {
    return `Must be under ${(rules.maxBytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  const maxPx = rules.maxDimensionPx ?? MAX_IMAGE_DIMENSION_PX;
  if (Math.max(info.width, info.height) > maxPx) {
    return `Must be at most ${maxPx} px on its longest side`;
  }
  if (info.width < 1 || info.height < 1) return "Image is empty";
  return null;
}

export const ANY_ACCEPTED_TYPE: readonly AcceptedImageType[] = ACCEPTED_IMAGE_TYPES;

/**
 * Decoding and re-encoding. Implemented with sharp (./sharp-processor.ts);
 * link-import reuses it for downloaded product images.
 */
export interface ServerImageProcessor {
  /**
   * Read the header only: real type (from bytes), pixel size and whether
   * there's an alpha channel. Throws InvalidImageError if it isn't a
   * readable JPEG, PNG or WebP. Cheap: doesn't decode the pixels.
   */
  inspect(data: Uint8Array): Promise<ImageInfo>;
  /**
   * True if the image has an alpha channel AND at least one pixel that
   * isn't fully opaque. A PNG without that isn't a cut-out.
   */
  hasTransparency(image: ImageInput): Promise<boolean>;
  /**
   * Re-encode without EXIF or other metadata (location!), keeping the
   * format and the transparency of PNG cut-outs. Applies the EXIF
   * orientation first so the picture isn't left rotated.
   */
  stripMetadata(image: ImageInput): Promise<ImageInput>;
  /**
   * Shrink to fit within maxPx on the longest side (for downloaded product
   * images and thumbnails). Never enlarges. Also strips metadata.
   */
  resize(image: ImageInput, maxPx: number): Promise<ImageInput>;
  /**
   * A small JPEG to send to a vision model: fitted within maxPx, any
   * transparency flattened onto a plain light grey (MODEL_BACKGROUND), no
   * metadata.
   */
  prepareForModel(image: ImageInput, maxPx: number): Promise<ImageInput>;
}

let processor: ServerImageProcessor | undefined;

export function getServerImageProcessor(): ServerImageProcessor {
  processor ??= new SharpImageProcessor();
  return processor;
}
