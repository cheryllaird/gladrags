/**
 * Checking and cleaning uploaded images before they're stored (spec:
 * "Server strips EXIF, validates both images and stores them"). Shared by
 * add-by-photo and add-by-link step 2.
 *
 * Every problem with an image surfaces as a bad_request ApiException whose
 * `issues[0].path` names the upload field, never as a 500.
 */
import "server-only";
import { ACCEPTED_IMAGE_TYPES, CUTOUT_IMAGE_TYPE, MAX_CUTOUT_BYTES, MAX_ORIGINAL_BYTES } from "@/contracts";
import type { ImageInput } from "@/lib/ai/types";
import { ApiException } from "@/lib/api/errors";
import type { UploadedImage } from "@/lib/api/upload";
import { InvalidImageError, checkImage, type ImageRules, type ServerImageProcessor } from "@/lib/images/server";

export const ORIGINAL_RULES: ImageRules = { allowedTypes: ACCEPTED_IMAGE_TYPES, maxBytes: MAX_ORIGINAL_BYTES };
export const CUTOUT_RULES: ImageRules = { allowedTypes: [CUTOUT_IMAGE_TYPE], maxBytes: MAX_CUTOUT_BYTES };

/** An image that passed its checks, with its upright pixel size. */
export interface CheckedImage extends ImageInput {
  width: number;
  height: number;
}

export function invalidImage(field: string, label: string, detail: string): ApiException {
  return new ApiException("bad_request", `That ${label} can't be used: ${detail.toLowerCase()}`, {
    issues: [{ path: field, message: detail }],
  });
}

/** Run an image operation, turning InvalidImageError into a 400 on the field. */
async function onField<T>(field: string, label: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof InvalidImageError) throw invalidImage(field, label, "Not a readable image");
    throw error;
  }
}

/**
 * Decode the header and check type, size and pixel dimensions. Throws a
 * bad_request ApiException naming the field.
 */
export async function checkUploadedImage(
  images: ServerImageProcessor,
  upload: UploadedImage,
  field: string,
  label: string,
  rules: ImageRules,
): Promise<CheckedImage> {
  const info = await onField(field, label, () => images.inspect(upload.data));
  const problem = checkImage(info, rules);
  if (problem) throw invalidImage(field, label, problem);
  return { data: upload.data, mimeType: info.mimeType, width: info.width, height: info.height };
}

/**
 * Check a cut-out (CONTRACTS.md section 5, plus the orchestrator's rules):
 * - type, size and pixel limits as for any upload, and it must decode;
 * - it can't be wider or taller than the original it was cut from;
 * - fewer than 1% see-through pixels means it isn't a cut-out: returns
 *   null (treated as missing) rather than failing the upload.
 * Problems are 400s on `field`.
 */
export async function checkUploadedCutout(
  images: ServerImageProcessor,
  upload: UploadedImage,
  field: string,
  original: { width: number; height: number },
): Promise<CheckedImage | null> {
  const cutout = await checkUploadedImage(images, upload, field, "cut-out", CUTOUT_RULES);
  if (cutout.width > original.width || cutout.height > original.height) {
    throw invalidImage(field, "cut-out", "Must not be larger than the photo it was cut from");
  }
  const transparent = await onField(field, "cut-out", () => images.hasTransparency(cutout));
  return transparent ? cutout : null;
}

/**
 * Strip EXIF and other metadata. This decodes every pixel, so a truncated
 * or corrupt file fails here (as a 400 on `field`). Re-encoding can
 * occasionally make a file bigger than the bucket allows, so shrink it a
 * little until it fits.
 */
export async function cleanImage(
  images: ServerImageProcessor,
  image: ImageInput,
  maxBytes: number,
  field: string,
  label: string,
): Promise<ImageInput> {
  return onField(field, label, async () => {
    let clean = await images.stripMetadata(image);
    if (clean.data.byteLength > maxBytes) {
      const info = await images.inspect(clean.data);
      let size = Math.max(info.width, info.height);
      for (let attempt = 0; clean.data.byteLength > maxBytes && attempt < 4; attempt++) {
        size = Math.round(size * 0.85);
        clean = await images.resize(clean, size);
      }
    }
    if (clean.data.byteLength > maxBytes) {
      throw invalidImage(field, label, "Too large to store, even after shrinking it");
    }
    return { data: clean.data, mimeType: clean.mimeType };
  });
}
