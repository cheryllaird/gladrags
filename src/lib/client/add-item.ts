/**
 * The add-item pipelines the screens run, step by step:
 *
 * Photo:  prepare (resize + JPEG) -> cut out (in the browser) -> upload + tag
 * Link:   [step 1 is importLink] -> load the product image -> cut out -> upload cut-out + tag
 *
 * Background removal is allowed to fail (older or low-memory phones): the
 * item is then uploaded without a cut-out and uses the original image.
 * Dependencies are parameters so the pipelines can be unit-tested without a
 * browser.
 */
import type { BackgroundRemover } from "@/lib/images";
import type { ItemDraft } from "@/contracts";
import { uploadLinkCutout, uploadPhoto, type NamedBlob } from "./api";
import { getClientBackgroundRemover } from "./background-remover";
import { fitCutout, prepareOriginal, renameWithExtension } from "./photo";

export type AddStage = "preparing" | "cutting_out" | "uploading";

export const ADD_STAGE_LABELS: Record<AddStage, string> = {
  preparing: "Preparing the photo",
  cutting_out: "Cutting out the item",
  uploading: "Uploading and tagging",
};

export interface AddResult {
  draft: ItemDraft;
  /** True if background removal failed, so the original image is used. */
  cutoutFailed: boolean;
}

export interface PipelineDeps {
  prepare: (file: Blob) => Promise<Blob>;
  remover: BackgroundRemover;
  fitCutout: (cutout: Blob) => Promise<Blob | null>;
  uploadPhoto: typeof uploadPhoto;
  uploadLinkCutout: typeof uploadLinkCutout;
  fetchImage: (url: string) => Promise<Blob>;
}

async function fetchImage(url: string): Promise<Blob> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Image request failed: ${response.status}`);
  return response.blob();
}

export function defaultDeps(): PipelineDeps {
  return {
    prepare: prepareOriginal,
    remover: getClientBackgroundRemover(),
    fitCutout,
    uploadPhoto,
    uploadLinkCutout,
    fetchImage,
  };
}

/** Cut out, or null if removal fails for any reason. Never throws. */
async function tryCutOut(image: Blob, deps: PipelineDeps, name: string): Promise<NamedBlob | null> {
  try {
    const cutout = await deps.fitCutout(await deps.remover.removeBackground(image));
    return cutout ? { blob: cutout, name: renameWithExtension(name, "png") } : null;
  } catch {
    return null;
  }
}

/** Add by photo (also the screenshot fallback for a link, with `sourceUrl`). */
export async function addByPhoto(
  file: File,
  options: { sourceUrl?: string; onStage?: (stage: AddStage) => void; deps?: PipelineDeps } = {},
): Promise<AddResult> {
  const deps = options.deps ?? defaultDeps();
  options.onStage?.("preparing");
  const original = await deps.prepare(file);
  const originalName = renameWithExtension(file.name || "photo", "jpg");

  options.onStage?.("cutting_out");
  const cutout = await tryCutOut(original, deps, originalName);

  options.onStage?.("uploading");
  const draft = await deps.uploadPhoto({
    original: { blob: original, name: originalName },
    cutout,
    sourceUrl: options.sourceUrl,
  });
  return { draft, cutoutFailed: cutout === null };
}

/** Add by link, step 2: cut out the stored product image and send the cut-out for tagging. */
export async function finishLinkImport(
  step1: { originalImageKey: string; originalUrl: string },
  options: { onStage?: (stage: AddStage) => void; deps?: PipelineDeps } = {},
): Promise<AddResult> {
  const deps = options.deps ?? defaultDeps();
  options.onStage?.("cutting_out");
  let cutout: NamedBlob | null = null;
  try {
    cutout = await tryCutOut(await deps.fetchImage(step1.originalUrl), deps, "product.png");
  } catch {
    // Couldn't load the product image here; the server still has it and tags the original.
    cutout = null;
  }

  options.onStage?.("uploading");
  const draft = await deps.uploadLinkCutout({ originalImageKey: step1.originalImageKey, cutout });
  return { draft, cutoutFailed: cutout === null };
}

/**
 * The product link from a share-target visit. Android may put the link in
 * `url`, or only inside `text` ("Look at this https://…").
 */
export function linkFromShare(params: { url?: string | null; text?: string | null }): string {
  const candidates = [params.url, params.text];
  for (const value of candidates) {
    const match = value?.match(/https?:\/\/[^\s<>"']+/i);
    if (match) return match[0];
  }
  return "";
}
