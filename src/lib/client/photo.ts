/**
 * Getting a phone photo ready to upload, in the browser (CONTRACTS.md
 * section 5, "Add by photo"):
 *
 * - resize so the longest side is at most 1600 px,
 * - re-encode as JPEG (iPhones take HEIC, which the server refuses),
 * - lower the JPEG quality if needed to stay under the 1.5 MB limit,
 * - shrink an oversized cut-out PNG until it fits under 2.5 MB.
 *
 * The ingestion agent is building its own resize helper in parallel; if it
 * lands in src/lib/images, prepareOriginal can delegate to it.
 */
import { MAX_CUTOUT_BYTES, MAX_IMAGE_DIMENSION_PX, MAX_ORIGINAL_BYTES } from "@/contracts";

export class PhotoPrepError extends Error {
  constructor(message = "We couldn't read that photo. Try a different one, or take a new photo.") {
    super(message);
    this.name = "PhotoPrepError";
  }
}

/** Scale (width, height) down so neither side exceeds `max`. Never scales up. */
export function fitWithin(width: number, height: number, max: number = MAX_IMAGE_DIMENSION_PX): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= max) return { width, height };
  const scale = max / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * The name to upload a re-encoded photo under: the original name with a new
 * extension. Keeping the stem keeps mock-mode markers ("shirt-mock-no-tags")
 * working; the server never uses the name for storage.
 */
export function renameWithExtension(name: string, extension: "jpg" | "png"): string {
  const stem = name.replace(/\.[^./\\]*$/, "").trim() || "photo";
  return `${stem}.${extension}`;
}

/** JPEG qualities to try, best first, until the file fits. */
export const JPEG_QUALITIES = [0.85, 0.75, 0.65, 0.5] as const;

interface Decoded {
  source: CanvasImageSource;
  width: number;
  height: number;
  close(): void;
}

async function decode(blob: Blob): Promise<Decoded> {
  // createImageBitmap respects EXIF orientation, so phone photos aren't sideways.
  try {
    const bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
    return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
  } catch {
    // Some browsers (Safari with HEIC, SVG anywhere) only decode through <img>.
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    if (!img.naturalWidth || !img.naturalHeight) throw new PhotoPrepError();
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
  } catch {
    URL.revokeObjectURL(url);
    throw new PhotoPrepError();
  }
}

function draw(image: Decoded, width: number, height: number, background: string | null): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new PhotoPrepError("Your browser couldn't process that photo.");
  if (background) {
    // JPEG has no transparency: put see-through screenshots on white, not black.
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, width, height);
  }
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(image.source, 0, 0, width, height);
  return canvas;
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new PhotoPrepError())), type, quality);
  });
}

/** Resize to ≤ 1600 px and re-encode as a JPEG under MAX_ORIGINAL_BYTES. */
export async function prepareOriginal(file: Blob): Promise<Blob> {
  const image = await decode(file);
  try {
    let size = fitWithin(image.width, image.height);
    // Quality first; if even the lowest is too big (rare), shrink the pixels too.
    for (let attempt = 0; attempt < 3; attempt++) {
      const canvas = draw(image, size.width, size.height, "#ffffff");
      for (const quality of JPEG_QUALITIES) {
        const blob = await toBlob(canvas, "image/jpeg", quality);
        if (blob.size <= MAX_ORIGINAL_BYTES) return blob;
      }
      size = { width: Math.round(size.width * 0.75), height: Math.round(size.height * 0.75) };
    }
    throw new PhotoPrepError("That photo is too large to upload. Try a different one.");
  } finally {
    image.close();
  }
}

/**
 * Make sure a cut-out PNG is within the upload limits, shrinking it if
 * needed. Returns null if it can't be made to fit: the item is then saved
 * without a cut-out, as when removal fails.
 */
export async function fitCutout(cutout: Blob): Promise<Blob | null> {
  if (cutout.size <= MAX_CUTOUT_BYTES) return cutout;
  let image: Decoded;
  try {
    image = await decode(cutout);
  } catch {
    return null;
  }
  try {
    let size = fitWithin(image.width, image.height);
    for (let attempt = 0; attempt < 4; attempt++) {
      size = { width: Math.round(size.width * 0.8), height: Math.round(size.height * 0.8) };
      const blob = await toBlob(draw(image, size.width, size.height, null), "image/png");
      if (blob.size <= MAX_CUTOUT_BYTES) return blob;
    }
    return null;
  } finally {
    image.close();
  }
}
