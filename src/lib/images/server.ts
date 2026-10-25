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

export { sniffImageType } from "./sniff";

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
   * Read the header only: real type (magic bytes checked first, so nothing
   * but JPEG, PNG or WebP reaches the decoder), upright pixel size (EXIF
   * orientation applied) and whether there's an alpha channel. Throws
   * InvalidImageError otherwise. Cheap: doesn't decode the pixels, so a
   * truncated file can still pass; stripMetadata decodes it fully.
   */
  inspect(data: Uint8Array): Promise<ImageInfo>;
  /**
   * True if at least 1% of the pixels are see-through (alpha < 250). A PNG
   * without that isn't a cut-out. Decodes every pixel: throws
   * InvalidImageError for a truncated or corrupt file.
   */
  hasTransparency(image: ImageInput): Promise<boolean>;
  /**
   * Re-encode without EXIF or other metadata (location!), keeping the
   * format and the transparency of PNG cut-outs. Applies the EXIF
   * orientation first so the picture isn't left rotated. Decodes every
   * pixel: throws InvalidImageError for a truncated or corrupt file.
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
