/**
 * The background-removal model and its pre- and post-processing, as pure
 * functions (no DOM), so they can be unit-tested.
 *
 * Model: U²-Netp ("u2netp"), the small version of U²-Net, a salient object
 * segmentation network (Qin et al., 2020). Apache-2.0. The ONNX file is the
 * one rembg distributes, served from /models (see public/models/NOTICE.txt).
 * 4.6 MB, 320 × 320 input, one mask out. It finds "the main thing in the
 * photo", which for a single garment laid flat or on a hanger is the item.
 *
 * Client-safe: no server imports.
 */

export interface SegmentationModel {
  /** Served from public/. The ?v= part changes whenever the file does, so caches refresh. */
  url: string;
  /** SHA-256 of the file, checked by a unit test. */
  sha256: string;
  bytes: number;
  /** Square input size in pixels. */
  inputSize: number;
  /** ImageNet normalisation, per RGB channel. */
  mean: readonly [number, number, number];
  std: readonly [number, number, number];
}

export const U2NETP_MODEL: SegmentationModel = {
  url: "/models/u2netp.onnx?v=8e83ca70",
  sha256: "309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8",
  bytes: 4_574_861,
  inputSize: 320,
  mean: [0.485, 0.456, 0.406],
  std: [0.229, 0.224, 0.225],
};

/**
 * RGBA pixels (already scaled to size × size) to the model's input tensor
 * data: planar RGB (CHW), scaled by the brightest value then normalised,
 * as rembg does for this model.
 */
export function toModelInput(rgba: Uint8ClampedArray | Uint8Array, size: number, model: SegmentationModel = U2NETP_MODEL): Float32Array {
  const pixels = size * size;
  if (rgba.length !== pixels * 4) throw new Error(`Expected ${pixels * 4} RGBA values, got ${rgba.length}`);
  let max = 1;
  for (let i = 0; i < rgba.length; i++) {
    if (i % 4 !== 3 && rgba[i]! > max) max = rgba[i]!;
  }
  const out = new Float32Array(3 * pixels);
  for (let p = 0; p < pixels; p++) {
    for (let c = 0; c < 3; c++) {
      out[c * pixels + p] = (rgba[p * 4 + c]! / max - model.mean[c]!) / model.std[c]!;
    }
  }
  return out;
}

export interface MaskOptions {
  /** Normalised probability at or below which a pixel is fully transparent. */
  low?: number;
  /** At or above which it's fully opaque. In between fades linearly. */
  high?: number;
}

/**
 * The model's raw prediction to an 8-bit alpha mask. The prediction is
 * stretched to 0–1 first (as rembg does), then faint background haze below
 * `low` is cut to fully transparent and the item above `high` made fully
 * opaque, which keeps edges soft without a grey halo.
 */
export function maskFromPrediction(prediction: Float32Array, { low = 0.1, high = 0.9 }: MaskOptions = {}): Uint8ClampedArray {
  let min = Infinity;
  let max = -Infinity;
  for (const v of prediction) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = max - min;
  const mask = new Uint8ClampedArray(prediction.length);
  if (!(range > 1e-6)) return mask; // flat prediction: nothing found
  for (let i = 0; i < prediction.length; i++) {
    const p = (prediction[i]! - min) / range;
    const a = (p - low) / (high - low);
    mask[i] = Math.round(Math.min(1, Math.max(0, a)) * 255);
  }
  return mask;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MaskStats {
  /** Share of pixels that are mostly opaque (alpha ≥ 128), 0–1. */
  coverage: number;
  /** Smallest box around the mostly-opaque pixels, in mask pixels; null if there are none. */
  box: Box | null;
}

export function maskStats(mask: Uint8ClampedArray, size: number, threshold = 128): MaskStats {
  let count = 0;
  let x0 = size;
  let y0 = size;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (mask[y * size + x]! >= threshold) {
        count++;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return {
    coverage: count / (size * size),
    box: count === 0 ? null : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 },
  };
}

/** Below this the model found nothing; above it, it couldn't tell the item from the background. */
export const MIN_SUBJECT_COVERAGE = 0.005;
export const MAX_SUBJECT_COVERAGE = 0.97;

export function hasUsableSubject(stats: MaskStats): boolean {
  return stats.box !== null && stats.coverage >= MIN_SUBJECT_COVERAGE && stats.coverage <= MAX_SUBJECT_COVERAGE;
}

/**
 * Scale a box found on the size × size mask up to the full image, with a
 * small margin so soft edges aren't clipped, kept inside the image.
 */
export function cropBox(maskBox: Box, maskSize: number, width: number, height: number, marginFraction = 0.03): Box {
  const sx = width / maskSize;
  const sy = height / maskSize;
  const margin = Math.round(Math.max(width, height) * marginFraction);
  const x = Math.max(0, Math.floor(maskBox.x * sx) - margin);
  const y = Math.max(0, Math.floor(maskBox.y * sy) - margin);
  const right = Math.min(width, Math.ceil((maskBox.x + maskBox.width) * sx) + margin);
  const bottom = Math.min(height, Math.ceil((maskBox.y + maskBox.height) * sy) + margin);
  return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
}

/** Size that fits within maxPx on the longest side, keeping the aspect ratio. Never enlarges. */
export function fitWithin(width: number, height: number, maxPx: number): { width: number; height: number } {
  const scale = Math.min(1, maxPx / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}
