/**
 * In-browser background removal (spec: "Add by photo", step 2): the U²-Netp
 * segmentation model (./u2net.ts) run with ONNX Runtime Web on WebAssembly.
 * Nothing leaves the phone.
 *
 * - First use downloads the model (4.6 MB) and the runtime (14 MB, about
 *   3.7 MB compressed), then keeps both in Cache Storage (./model-cache.ts).
 *   Call warmUp() when the add-item screen opens so the download overlaps
 *   with taking the photo.
 * - One inference at 320 × 320, then the mask is scaled up to the photo and
 *   the result cropped to the item. Expect roughly 1–4 s per photo on a
 *   mid-range phone (single-threaded WebAssembly).
 * - Every failure becomes a BackgroundRemovalError, so the caller can upload
 *   the original alone (spec fallback).
 *
 * Client-only.
 */
import { MAX_CUTOUT_BYTES, MAX_IMAGE_DIMENSION_PX } from "@/contracts";
import { canvasToBlob, context2d, createCanvas, decodeImage, fromBitmap, type DecodedImage } from "./canvas";
import { fetchWithCache, pruneCache } from "./model-cache";
import { BackgroundRemovalError, type BackgroundRemovalFailure, type BackgroundRemover } from "./types";
import { U2NETP_MODEL, cropBox, fitWithin, hasUsableSubject, maskFromPrediction, maskStats, toModelInput, type SegmentationModel } from "./u2net";

/** onnxruntime-web version; the runtime file is copied to public/ort by scripts/copy-ort-wasm.mjs. */
export const ORT_VERSION = "1.30.0";
export const ORT_WASM_URL = `/ort/ort-wasm-simd-threaded.wasm?v=${ORT_VERSION}`;

type Ort = typeof import("onnxruntime-web/wasm");
type Session = import("onnxruntime-web/wasm").InferenceSession;

export interface OnnxBackgroundRemoverOptions {
  model?: SegmentationModel;
  wasmUrl?: string;
  /** Longest side of the cut-out. */
  maxPx?: number;
  /** Largest PNG the server accepts; bigger cut-outs are scaled down until they fit. */
  maxBytes?: number;
}

/** Timings from the last successful run, for diagnostics. */
export interface RemovalTimings {
  loadMs: number;
  inferenceMs: number;
  totalMs: number;
}

function failureFor(error: unknown, stage: "load" | "run"): BackgroundRemovalError {
  if (error instanceof BackgroundRemovalError) return error;
  const message = error instanceof Error ? error.message : String(error);
  let reason: BackgroundRemovalFailure;
  if (error instanceof RangeError || /memory|allocat|\bOOM\b/i.test(message)) reason = "out_of_memory";
  else if (stage === "load") reason = "model_load_failed";
  else reason = "unsupported";
  return new BackgroundRemovalError(reason, `Background removal failed (${reason}): ${message}`);
}

export class OnnxBackgroundRemover implements BackgroundRemover {
  readonly name = "u2netp-onnx-wasm";
  lastTimings: RemovalTimings | null = null;

  private readonly model: SegmentationModel;
  private readonly wasmUrl: string;
  private readonly maxPx: number;
  private readonly maxBytes: number;
  private loading: Promise<{ ort: Ort; session: Session }> | null = null;

  constructor(options: OnnxBackgroundRemoverOptions = {}) {
    this.model = options.model ?? U2NETP_MODEL;
    this.wasmUrl = options.wasmUrl ?? ORT_WASM_URL;
    this.maxPx = options.maxPx ?? MAX_IMAGE_DIMENSION_PX;
    this.maxBytes = options.maxBytes ?? MAX_CUTOUT_BYTES;
  }

  /** True if this browser has what the remover needs. */
  static isSupported(): boolean {
    return (
      typeof WebAssembly === "object" &&
      typeof fetch === "function" &&
      (typeof OffscreenCanvas !== "undefined" || typeof document !== "undefined")
    );
  }

  /**
   * Download (or load from cache) the runtime and model and start a session.
   * Safe to call many times; a failed load is retried on the next call.
   */
  async warmUp(): Promise<void> {
    await this.load();
  }

  async removeBackground(image: Blob | ImageBitmap): Promise<Blob> {
    if (!OnnxBackgroundRemover.isSupported()) throw new BackgroundRemovalError("unsupported");
    const started = performance.now();

    const { ort, session } = await this.load();
    const loadMs = performance.now() - started;

    let decoded: DecodedImage;
    try {
      decoded = image instanceof Blob ? await decodeImage(image) : fromBitmap(image);
    } catch (error) {
      throw new BackgroundRemovalError("unsupported", error instanceof Error ? error.message : undefined);
    }

    try {
      const size = this.model.inputSize;

      // 1. The model sees a size × size squashed copy, as it was trained.
      const small = createCanvas(size, size);
      const smallCtx = context2d(small, { willReadFrequently: true });
      smallCtx.drawImage(decoded.source, 0, 0, size, size);
      const input = toModelInput(smallCtx.getImageData(0, 0, size, size).data, size, this.model);

      const inferenceStarted = performance.now();
      const feeds = { [session.inputNames[0]!]: new ort.Tensor("float32", input, [1, 3, size, size]) };
      const results = await session.run(feeds);
      const inferenceMs = performance.now() - inferenceStarted;
      const prediction = results[session.outputNames[0]!]!.data as Float32Array;

      // 2. Prediction → alpha mask; give up if there's no clear item.
      const mask = maskFromPrediction(prediction);
      const stats = maskStats(mask, size);
      if (!hasUsableSubject(stats) || !stats.box) throw new BackgroundRemovalError("no_subject");

      // 3. Scale the mask up over the photo and keep only the item's pixels.
      const maskCanvas = createCanvas(size, size);
      const maskCtx = context2d(maskCanvas);
      const maskImage = maskCtx.createImageData(size, size);
      for (let i = 0; i < mask.length; i++) maskImage.data[i * 4 + 3] = mask[i]!;
      maskCtx.putImageData(maskImage, 0, 0);

      const full = fitWithin(decoded.width, decoded.height, this.maxPx);
      const composite = createCanvas(full.width, full.height);
      const ctx = context2d(composite);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(decoded.source, 0, 0, full.width, full.height);
      ctx.globalCompositeOperation = "destination-in";
      ctx.drawImage(maskCanvas, 0, 0, full.width, full.height);

      // 4. Crop to the item, then encode, shrinking until the PNG fits the upload limit.
      const crop = cropBox(stats.box, size, full.width, full.height);
      const blob = await this.encodeCropped(composite, crop);

      this.lastTimings = { loadMs, inferenceMs, totalMs: performance.now() - started };
      return blob;
    } catch (error) {
      throw failureFor(error, "run");
    } finally {
      decoded.close();
    }
  }

  private async encodeCropped(source: ReturnType<typeof createCanvas>, crop: { x: number; y: number; width: number; height: number }): Promise<Blob> {
    let scale = 1;
    for (let attempt = 0; attempt < 8; attempt++) {
      const width = Math.max(1, Math.round(crop.width * scale));
      const height = Math.max(1, Math.round(crop.height * scale));
      const out = createCanvas(width, height);
      const ctx = context2d(out);
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(source, crop.x, crop.y, crop.width, crop.height, 0, 0, width, height);
      const blob = await canvasToBlob(out, "image/png");
      if (blob.size <= this.maxBytes) return blob;
      scale *= 0.8;
    }
    throw new BackgroundRemovalError("out_of_memory", "The cut-out was too large to upload");
  }

  private load(): Promise<{ ort: Ort; session: Session }> {
    this.loading ??= this.createSession().catch((error: unknown) => {
      this.loading = null; // let the next photo try again
      throw failureFor(error, "load");
    });
    return this.loading;
  }

  private async createSession(): Promise<{ ort: Ort; session: Session }> {
    if (!OnnxBackgroundRemover.isSupported()) throw new BackgroundRemovalError("unsupported");
    const [ort, wasmBinary, modelBytes] = await Promise.all([
      import("onnxruntime-web/wasm"),
      fetchWithCache(this.wasmUrl),
      fetchWithCache(this.model.url),
    ]);
    // Threads need cross-origin isolation, which the app doesn't turn on
    // (it would block Supabase's signed image URLs).
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.wasmBinary = wasmBinary;
    const session = await ort.InferenceSession.create(new Uint8Array(modelBytes), {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
    });
    void pruneCache([this.wasmUrl, this.model.url]);
    return { ort, session };
  }
}
