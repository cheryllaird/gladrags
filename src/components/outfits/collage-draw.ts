/**
 * Draws a collage layout onto a canvas, and saves the result as an image.
 * Browser-only. Where things go is decided in collage-layout.ts; this file
 * only paints.
 */
import { fitContain, opaqueBounds, type Box, type CollageLayout } from "./collage-layout";

/** Restyle the collage here. Kept neutral until the look and feel is decided. */
export const COLLAGE_STYLE = {
  background: "#f5f5f5",
  placeholderFill: "#e5e5e5",
  placeholderText: "#737373",
  font: "500 32px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  shadow: { color: "rgba(0, 0, 0, 0.14)", blur: 18, offsetY: 8 },
} as const;

/**
 * Load an image for drawing. crossOrigin "anonymous" asks for CORS, so
 * images from signed Supabase URLs don't "taint" the canvas: a tainted
 * canvas can be shown but can't be saved as an image.
 */
export function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Couldn't load image ${url}`));
    img.src = url;
  });
}

export interface DrawResult {
  /** Items drawn as a labelled placeholder: their image didn't load, or was fully transparent. */
  placeholders: string[];
}

/**
 * Paint the collage. `images` maps item ID to its loaded image. An item
 * with no image (it failed to load), or whose image has nothing visible in
 * it (a cut-out that kept nothing), gets a labelled placeholder instead.
 */
export function drawCollage(
  ctx: CanvasRenderingContext2D,
  layout: CollageLayout,
  images: ReadonlyMap<string, HTMLImageElement>,
): DrawResult {
  const placeholders: string[] = [];
  ctx.save();
  ctx.clearRect(0, 0, layout.width, layout.height);
  ctx.fillStyle = COLLAGE_STYLE.background;
  ctx.fillRect(0, 0, layout.width, layout.height);

  for (const placed of layout.placed) {
    const img = images.get(placed.id);
    const source = img ? visibleRect(img) : null;
    if (img && source) {
      drawImage(ctx, img, source, placed.box);
    } else {
      drawPlaceholder(ctx, placed.box, placed.label);
      placeholders.push(placed.id);
    }
  }
  ctx.restore();
  return { placeholders };
}

function drawImage(ctx: CanvasRenderingContext2D, img: HTMLImageElement, source: Box, box: Box) {
  const fitted = fitContain(box, source.width, source.height);
  ctx.save();
  // A soft shadow lifts cut-outs off the background, as in a photographed flat-lay.
  ctx.shadowColor = COLLAGE_STYLE.shadow.color;
  ctx.shadowBlur = COLLAGE_STYLE.shadow.blur;
  ctx.shadowOffsetY = COLLAGE_STYLE.shadow.offsetY;
  ctx.drawImage(img, source.x, source.y, source.width, source.height, fitted.x, fitted.y, fitted.width, fitted.height);
  ctx.restore();
}

/** Longest side of the copy scanned for transparency: plenty for finding edges, and fast. */
const TRIM_SCAN_SIZE = 256;

/**
 * The image's non-transparent area, in its own pixels, so a cut-out's empty
 * margin doesn't shrink the item. The whole image if it has no transparency,
 * or if its pixels can't be read. Null if it's entirely transparent.
 */
function visibleRect(img: HTMLImageElement): Box | null {
  const full: Box = { x: 0, y: 0, width: img.naturalWidth, height: img.naturalHeight };
  if (!full.width || !full.height) return full;
  let scan: HTMLCanvasElement | null = null;
  try {
    const scale = Math.min(1, TRIM_SCAN_SIZE / Math.max(full.width, full.height));
    const w = Math.max(1, Math.round(full.width * scale));
    const h = Math.max(1, Math.round(full.height * scale));
    scan = document.createElement("canvas");
    scan.width = w;
    scan.height = h;
    const sctx = scan.getContext("2d", { willReadFrequently: true });
    if (!sctx) return full;
    sctx.drawImage(img, 0, 0, w, h);
    const bounds = opaqueBounds(sctx.getImageData(0, 0, w, h).data, w, h);
    if (!bounds) return null;
    // Back to the image's own pixels, with a pixel of slack for rounding.
    const x = Math.max(0, Math.floor((bounds.x - 1) / scale));
    const y = Math.max(0, Math.floor((bounds.y - 1) / scale));
    return {
      x,
      y,
      width: Math.min(full.width, Math.ceil((bounds.x + bounds.width + 1) / scale)) - x,
      height: Math.min(full.height, Math.ceil((bounds.y + bounds.height + 1) / scale)) - y,
    };
  } catch {
    return full;
  } finally {
    // Free the scan canvas's memory now rather than at garbage collection
    // (mobile Safari caps total canvas memory).
    if (scan) {
      scan.width = 0;
      scan.height = 0;
    }
  }
}

function drawPlaceholder(ctx: CanvasRenderingContext2D, box: Box, label: string) {
  const inset = 12;
  ctx.save();
  ctx.fillStyle = COLLAGE_STYLE.placeholderFill;
  ctx.beginPath();
  ctx.roundRect(box.x + inset, box.y + inset, box.width - inset * 2, box.height - inset * 2, 24);
  ctx.fill();
  ctx.fillStyle = COLLAGE_STYLE.placeholderText;
  ctx.font = COLLAGE_STYLE.font;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, box.x + box.width / 2, box.y + box.height / 2, box.width - inset * 4);
  ctx.restore();
}

/** "Easy weekend" -> "gladrags-easy-weekend.png" */
export function collageFileName(outfitName: string): string {
  const slug = outfitName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `gladrags-${slug || "outfit"}.png`;
}

export type SaveResult = "shared" | "downloaded" | "cancelled";

/** The canvas as a PNG. Throws if it can't be exported (e.g. a tainted canvas). */
export async function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("Couldn't make an image from the collage");
  return blob;
}

/**
 * Save a collage PNG. On phones that can share files (iPhone, Android) this
 * opens the share sheet, which has "Save image"; elsewhere it downloads.
 *
 * Call it straight from the click handler with a blob made beforehand:
 * browsers only allow navigator.share during the tap's "user activation",
 * so nothing may be awaited before it. This function awaits nothing before
 * calling share.
 */
export function saveImageBlob(blob: Blob, outfitName: string): Promise<SaveResult> {
  const fileName = collageFileName(outfitName);
  const file = new File([blob], fileName, { type: "image/png" });
  if (typeof navigator.canShare === "function" && navigator.canShare({ files: [file] })) {
    return navigator.share({ files: [file], title: outfitName }).then(
      (): SaveResult => "shared",
      (error: unknown): SaveResult => {
        // The user closed the share sheet: that's not a failure.
        if (error instanceof DOMException && error.name === "AbortError") return "cancelled";
        // Anything else (e.g. share not allowed here): fall back to a download.
        return download(blob, fileName);
      },
    );
  }
  return Promise.resolve(download(blob, fileName));
}

function download(blob: Blob, fileName: string): SaveResult {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  // Give the browser a moment to start the download before freeing the blob.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return "downloaded";
}

/** Export and save in one go, for callers without a ready-made blob. Throws if the canvas can't be exported. */
export async function saveCanvasAsImage(canvas: HTMLCanvasElement, outfitName: string): Promise<SaveResult> {
  return saveImageBlob(await canvasToPng(canvas), outfitName);
}
