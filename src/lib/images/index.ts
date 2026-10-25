/**
 * Client-side image tools. Server-side helpers (type sniffing, limits,
 * EXIF stripping) are in ./server.ts.
 *
 * - getBackgroundRemover(): the real in-browser remover (U²-Netp on ONNX
 *   Runtime Web). preloadBackgroundRemover() starts its one-off download.
 * - preparePhotoUpload() / prepareImageForUpload() / buildPhotoUploadForm():
 *   resize to ≤ 1600 px, re-encode as JPEG (drops EXIF, converts HEIC),
 *   cut out, and build the upload body. See ./prepare-upload.ts.
 * - FakeBackgroundRemover: for tests and UI work.
 */
import { OnnxBackgroundRemover } from "./onnx-background-remover";
import { BackgroundRemovalError, type BackgroundRemover } from "./types";

export * from "./types";
export { OnnxBackgroundRemover, type RemovalTimings } from "./onnx-background-remover";
export {
  ImagePreparationError,
  buildPhotoUploadForm,
  jpegFileName,
  prepareImageForUpload,
  preparePhotoUpload,
  type ImagePreparationFailure,
  type PreparedImage,
  type PreparedPhotoUpload,
} from "./prepare-upload";
export { isCached as isModelCached } from "./model-cache";

/**
 * For tests and mock mode. Returns `result` (default: a fixed tiny PNG), or
 * fails with the given reason so the UI can exercise the no-cut-out path.
 */
export class FakeBackgroundRemover implements BackgroundRemover {
  readonly name = "fake";
  calls = 0;

  constructor(private readonly options: { fail?: BackgroundRemovalError["reason"]; result?: Blob } = {}) {}

  async removeBackground(): Promise<Blob> {
    this.calls++;
    if (this.options.fail) throw new BackgroundRemovalError(this.options.fail);
    return this.options.result ?? new Blob([TRANSPARENT_PIXEL_PNG], { type: "image/png" });
  }
}

/** A valid 1×1 transparent PNG. */
const TRANSPARENT_PIXEL_PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0),
);

let remover: OnnxBackgroundRemover | undefined;

/**
 * The in-browser background remover. One shared instance, so the model is
 * loaded once per page. Call only in the browser.
 */
export function getBackgroundRemover(): BackgroundRemover {
  remover ??= new OnnxBackgroundRemover();
  return remover;
}

/**
 * Start downloading (or loading from cache) the model, e.g. when the
 * add-item screen opens. Never throws: if it fails, removeBackground tries
 * again and then falls back as usual.
 */
export async function preloadBackgroundRemover(): Promise<void> {
  try {
    remover ??= new OnnxBackgroundRemover();
    await remover.warmUp();
  } catch {
    // Handled when a photo is processed.
  }
}
