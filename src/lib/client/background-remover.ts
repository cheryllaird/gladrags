/**
 * The one place the add-item screens get their background remover from.
 *
 * Until the ingestion branch merges its in-browser model, this returns the
 * FakeBackgroundRemover (a fixed transparent PNG), which is all mock mode
 * needs. At merge, swap the body for `return getBackgroundRemover();` from
 * src/lib/images: nothing else in the UI changes.
 */
import { FakeBackgroundRemover, type BackgroundRemover } from "@/lib/images";

let remover: BackgroundRemover | null = null;

export function getClientBackgroundRemover(): BackgroundRemover {
  remover ??= new FakeBackgroundRemover();
  return remover;
}
