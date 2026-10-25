/**
 * Checking and cleaning uploaded images before they're stored (spec:
 * "Server strips EXIF, validates both images and stores them"). Shared by
 * add-by-photo and add-by-link step 2.
 */
import "server-only";
import { ACCEPTED_IMAGE_TYPES, CUTOUT_IMAGE_TYPE, MAX_CUTOUT_BYTES, MAX_ORIGINAL_BYTES } from "@/contracts";
import type { ImageInput } from "@/lib/ai/types";
import { ApiException } from "@/lib/api/errors";
import type { UploadedImage } from "@/lib/api/upload";
import { InvalidImageError, checkImage, type ImageRules, type ServerImageProcessor } from "@/lib/images/server";

export const ORIGINAL_RULES: ImageRules = { allowedTypes: ACCEPTED_IMAGE_TYPES, maxBytes: MAX_ORIGINAL_BYTES };
export const CUTOUT_RULES: ImageRules = { allowedTypes: [CUTOUT_IMAGE_TYPE], maxBytes: MAX_CUTOUT_BYTES };

function invalid(field: string, label: string, detail: string): ApiException {
  return new ApiException("bad_request", `That ${label} can't be used: ${detail.toLowerCase()}`, {
    issues: [{ path: field, message: detail }],
  });
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
): Promise<ImageInput> {
  let info;
  try {
    info = await images.inspect(upload.data);
  } catch (error) {
    if (error instanceof InvalidImageError) throw invalid(field, label, "Not a readable image");
    throw error;
  }
  const problem = checkImage(info, rules);
  if (problem) throw invalid(field, label, problem);
  return { data: upload.data, mimeType: info.mimeType };
}

/**
 * Check a cut-out. A PNG with no transparent pixels isn't a cut-out
 * (CONTRACTS.md: "treated as missing"), so that returns null rather than
 * failing the upload.
 */
export async function checkUploadedCutout(
  images: ServerImageProcessor,
  upload: UploadedImage,
  field: string,
): Promise<ImageInput | null> {
  const cutout = await checkUploadedImage(images, upload, field, "cut-out", CUTOUT_RULES);
  return (await images.hasTransparency(cutout)) ? cutout : null;
}

/**
 * Strip EXIF and other metadata. Re-encoding can occasionally make a file
 * bigger than the bucket allows, so shrink it a little until it fits.
 */
export async function cleanImage(images: ServerImageProcessor, image: ImageInput, maxBytes: number): Promise<ImageInput> {
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
    throw new ApiException("bad_request", "That image is too large to store, even after shrinking it");
  }
  return clean;
}
