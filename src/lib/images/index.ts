/**
 * Client-side image tools. Server-side helpers (type sniffing, limits,
 * EXIF stripping) are in ./server.ts.
 */
import { BackgroundRemovalError, type BackgroundRemover } from "./types";

export * from "./types";

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

/** The ingestion agent replaces this with the real in-browser implementation. */
export function getBackgroundRemover(): BackgroundRemover {
  throw new Error("No background remover yet: the ingestion agent adds the in-browser implementation.");
}
