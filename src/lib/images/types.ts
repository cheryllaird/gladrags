/**
 * Background removal runs IN THE BROWSER (spec change, 2026-10-21): there is
 * no hosted service and no server-side cost. This interface keeps the model
 * swappable. The ingestion agent builds the implementation in milestone 3.
 *
 * Client-safe: this file must not import any server module.
 */

/** Ways removal can fail on a phone. All are expected; the item is then saved without a cut-out. */
export type BackgroundRemovalFailure =
  | "unsupported" // browser lacks what the model needs (e.g. WebGPU/WASM features)
  | "out_of_memory" // older or low-memory phones
  | "model_load_failed" // model files couldn't be downloaded
  | "no_subject"; // nothing recognisable to cut out

export class BackgroundRemovalError extends Error {
  constructor(
    readonly reason: BackgroundRemovalFailure,
    message?: string,
  ) {
    super(message ?? `Background removal failed: ${reason}`);
    this.name = "BackgroundRemovalError";
  }
}

export interface BackgroundRemover {
  readonly name: string;
  /**
   * Cut the item out of an image that's already resized to ≤ 1600 px.
   * Resolves to a PNG Blob with a transparent background, at most
   * MAX_IMAGE_DIMENSION_PX on its longest side. Rejects with
   * BackgroundRemovalError; the caller then uploads without a cut-out.
   */
  removeBackground(image: Blob | ImageBitmap): Promise<Blob>;
}
