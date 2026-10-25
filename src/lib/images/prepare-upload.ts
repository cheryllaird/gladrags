/**
 * Getting a phone photo ready for POST /api/items/photo (spec: "Add by
 * photo", steps 1–2; CONTRACTS.md section 5):
 *
 * 1. prepareImageForUpload: decode (EXIF orientation applied), shrink to at
 *    most 1600 px, and re-encode as JPEG under 1.5 MB. Re-encoding drops all
 *    EXIF, location included, and turns iPhone HEIC photos (which the server
 *    rejects) into JPEG wherever the browser can decode them.
 * 2. preparePhotoUpload: the above, then try to cut the item out. If that
 *    fails, the item is uploaded without a cut-out.
 * 3. buildPhotoUploadForm: the multipart body.
 *
 * Typical use in the add-item screen:
 *
 *   const remover = getBackgroundRemover();
 *   void preloadBackgroundRemover();                 // when the screen opens
 *   const prepared = await preparePhotoUpload(file, remover);
 *   const res = await fetch("/api/items/photo", { method: "POST", body: buildPhotoUploadForm(prepared) });
 *
 * Client-only.
 */
import { MAX_IMAGE_DIMENSION_PX, MAX_ORIGINAL_BYTES, UPLOAD_FIELDS } from "@/contracts";
import { canvasToBlob, context2d, createCanvas, decodeImage } from "./canvas";
import { BackgroundRemovalError, type BackgroundRemovalFailure, type BackgroundRemover } from "./types";
import { fitWithin } from "./u2net";

export type ImagePreparationFailure =
  /** The browser can't decode the file (e.g. HEIC outside Safari, or not an image). */
  | "unreadable"
  /** Couldn't get it under the upload limit (very unusual). */
  | "too_large";

export class ImagePreparationError extends Error {
  constructor(
    readonly reason: ImagePreparationFailure,
    message?: string,
  ) {
    super(
      message ??
        (reason === "unreadable"
          ? "Couldn't read that photo. Try another one, or take a screenshot of it and use that."
          : "That photo is too large to upload."),
    );
    this.name = "ImagePreparationError";
  }
}

export interface PreparedImage {
  /** JPEG, ≤ 1600 px, ≤ 1.5 MB, no EXIF. */
  blob: Blob;
  width: number;
  height: number;
}

const JPEG_QUALITIES = [0.85, 0.75, 0.65] as const;

export async function prepareImageForUpload(
  file: Blob,
  { maxPx = MAX_IMAGE_DIMENSION_PX, maxBytes = MAX_ORIGINAL_BYTES }: { maxPx?: number; maxBytes?: number } = {},
): Promise<PreparedImage> {
  let decoded;
  try {
    decoded = await decodeImage(file);
  } catch {
    throw new ImagePreparationError("unreadable");
  }
  try {
    let { width, height } = fitWithin(decoded.width, decoded.height, maxPx);
    for (let attempt = 0; attempt < 4; attempt++) {
      const canvas = createCanvas(width, height);
      const ctx = context2d(canvas);
      // JPEG has no transparency: put transparent PNGs (screenshots) on white.
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, width, height);
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(decoded.source, 0, 0, width, height);
      for (const quality of JPEG_QUALITIES) {
        const blob = await canvasToBlob(canvas, "image/jpeg", quality);
        if (blob.size <= maxBytes) return { blob, width, height };
      }
      ({ width, height } = fitWithin(width, height, Math.round(Math.max(width, height) * 0.8)));
    }
    throw new ImagePreparationError("too_large");
  } finally {
    decoded.close();
  }
}

export interface PreparedPhotoUpload {
  original: PreparedImage;
  /** Transparent PNG, or null if removal failed (upload the original alone). */
  cutout: Blob | null;
  /** Why there's no cut-out, for logs or a gentle note in the UI. */
  cutoutFailure: BackgroundRemovalFailure | null;
  /** The file name to send: the phone's name with a .jpg extension (mock-mode markers live here). */
  fileName: string;
}

/** Resize and re-encode, then try the background remover. Only throws ImagePreparationError. */
export async function preparePhotoUpload(file: Blob, remover: BackgroundRemover): Promise<PreparedPhotoUpload> {
  const original = await prepareImageForUpload(file);
  const fileName = jpegFileName(file instanceof File ? file.name : "");
  try {
    const cutout = await remover.removeBackground(original.blob);
    return { original, cutout, cutoutFailure: null, fileName };
  } catch (error) {
    const cutoutFailure = error instanceof BackgroundRemovalError ? error.reason : "unsupported";
    console.warn("Background removal failed; uploading the photo without a cut-out", cutoutFailure);
    return { original, cutout: null, cutoutFailure, fileName };
  }
}

/** "IMG_1234.HEIC" → "IMG_1234.jpg". */
export function jpegFileName(name: string): string {
  const base = name.replace(/\.[^./\\]*$/, "").trim();
  return `${base || "photo"}.jpg`;
}

/** The multipart body for POST /api/items/photo. Pass sourceUrl for the add-by-link screenshot fallback. */
export function buildPhotoUploadForm(prepared: Pick<PreparedPhotoUpload, "original" | "cutout" | "fileName">, sourceUrl?: string): FormData {
  const form = new FormData();
  form.set(UPLOAD_FIELDS.original, prepared.original.blob, prepared.fileName);
  if (prepared.cutout) form.set(UPLOAD_FIELDS.cutout, prepared.cutout, "cutout.png");
  if (sourceUrl) form.set(UPLOAD_FIELDS.sourceUrl, sourceUrl);
  return form;
}
