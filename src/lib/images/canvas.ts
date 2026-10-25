/**
 * Small canvas helpers shared by the photo preparation and the background
 * remover. Use OffscreenCanvas where the browser has it, else a <canvas>.
 *
 * Client-only (needs a browser).
 */

export type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;
export type Context2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

export function createCanvas(width: number, height: number): AnyCanvas {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

export function context2d(canvas: AnyCanvas, options?: CanvasRenderingContext2DSettings): Context2D {
  const ctx = canvas.getContext("2d", options) as Context2D | null;
  // A null context usually means the browser couldn't allocate the canvas memory.
  if (!ctx) throw new RangeError("Couldn't create a 2D canvas (out of memory?)");
  return ctx;
}

export async function canvasToBlob(canvas: AnyCanvas, type: "image/png" | "image/jpeg", quality?: number): Promise<Blob> {
  if ("convertToBlob" in canvas) return canvas.convertToBlob({ type, quality });
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new RangeError("Couldn't encode the image (out of memory?)"))), type, quality);
  });
}

/** A decoded image, upright (EXIF orientation applied). Call close() when done. */
export interface DecodedImage {
  source: CanvasImageSource;
  width: number;
  height: number;
  close(): void;
}

/**
 * Decode a photo. Tries createImageBitmap (applies EXIF orientation), then
 * an <img> element, which some browsers can decode more formats with (e.g.
 * Safari and HEIC). Rejects if the browser can't read the file at all.
 */
export async function decodeImage(blob: Blob): Promise<DecodedImage> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
      return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
    } catch {
      // Fall through to <img>.
    }
  }
  if (typeof document === "undefined") throw new Error("This browser can't read that image");
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
  } catch {
    URL.revokeObjectURL(url);
    throw new Error("This browser can't read that image");
  }
}

/** Wrap an ImageBitmap the caller owns (we mustn't close it). */
export function fromBitmap(bitmap: ImageBitmap): DecodedImage {
  return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => {} };
}
