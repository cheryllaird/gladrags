/**
 * Server-side image checks and processing for the upload routes. The pure
 * checks are implemented here; decoding and EXIF stripping need an image
 * library (e.g. sharp), so they're an interface the ingestion agent
 * implements.
 */
import "server-only";
import { ACCEPTED_IMAGE_TYPES, MAX_IMAGE_DIMENSION_PX, type AcceptedImageType } from "@/contracts";
import type { ImageInput } from "@/lib/ai/types";

export type { ImageInput };

/** How long signed image URLs last in wardrobe and outfit responses. Images are private. */
export const SIGNED_URL_TTL_SECONDS = 60 * 60;

/** Thumbnail size sent to the ranking model's second pass (spec: around 256 px). */
export const RANKING_THUMBNAIL_PX = 256;

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
}

export interface ImageRules {
  allowedTypes: readonly AcceptedImageType[];
  maxBytes: number;
  maxDimensionPx?: number;
}

/** Check an image against the upload rules. Returns a user-facing problem, or null if it's fine. */
export function checkImage(info: ImageInfo, rules: ImageRules): string | null {
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
 * Decoding and metadata stripping. The ingestion agent implements this
 * (link-import reuses it for downloaded product images).
 */
export interface ServerImageProcessor {
  /** Decode the header: real type (from bytes) and pixel size. Throws if it isn't a readable image. */
  inspect(data: Uint8Array): Promise<ImageInfo>;
  /**
   * Re-encode without EXIF or other metadata (location!), keeping the
   * transparency of PNG cut-outs. Applies the EXIF orientation first so the
   * picture isn't left rotated.
   */
  stripMetadata(image: ImageInput): Promise<ImageInput>;
  /** Shrink to fit within maxPx on the longest side (for downloaded product images and thumbnails). */
  resize(image: ImageInput, maxPx: number): Promise<ImageInput>;
}

export function getServerImageProcessor(): ServerImageProcessor {
  throw new Error("No server image processor yet: the ingestion agent adds it.");
}
