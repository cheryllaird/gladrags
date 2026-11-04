/**
 * Draws a collage layout onto a canvas, and saves the result as an image.
 * Browser-only. Where things go is decided in collage-layout.ts; this file
 * only paints.
 */
import { fitContain, opaqueBounds, wrapText, type Box, type CollageGap, type CollageLayout } from "./collage-layout";

/** Restyle the collage here. Kept neutral until the look and feel is decided. */
export const COLLAGE_STYLE = {
  background: "#f5f5f5",
  placeholderFill: "#e5e5e5",
  placeholderText: "#737373",
  font: "500 32px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  /** Gaps: a dashed outline with the suggested item's description. */
  gap: {
    fill: "rgba(255, 255, 255, 0.6)",
    border: "#a3a3a3",
    dash: [18, 12],
    lineWidth: 4,
    swatchBorder: "#d4d4d4",
    swatchRadius: 18,
    text: "#525252",
    /** Description and product name sizes in px, at full size; a tight slot uses COMPACT_SCALE. */
    fontSize: 30,
    smallFontSize: 24,
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
    lineHeight: 38,
  },
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
  /**
   * Items drawn as a labelled placeholder: their image didn't load, or was
   * fully transparent. Gaps are not counted: their placeholder is intended.
   */
  placeholders: string[];
}

/**
 * Paint the collage. `images` maps item ID to its loaded image. An item
 * with no image (it failed to load), or whose image has nothing visible in
 * it (a cut-out that kept nothing), gets a labelled placeholder instead.
 * A gap gets a dashed placeholder with its description and colours.
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
    if (placed.gap) {
      drawGap(ctx, placed.box, placed.gap);
      continue;
    }
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

/** True if the image has something visible in it (not a fully transparent cut-out). */
export function hasVisibleContent(img: HTMLImageElement): boolean {
  return visibleRect(img) !== null;
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

/**
 * A gap: a dashed rounded outline in the slot, colour swatches, then the
 * suggested item's description, and the chosen shop product's name below
 * (never its picture: shop pictures stay off the canvas so it can be saved).
 */
function drawGap(ctx: CanvasRenderingContext2D, box: Box, gap: CollageGap) {
  const style = COLLAGE_STYLE.gap;
  const inset = 16;
  const inner = { x: box.x + inset, y: box.y + inset, width: box.width - inset * 2, height: box.height - inset * 2 };
  const textWidth = inner.width - 32;
  ctx.save();

  ctx.fillStyle = style.fill;
  ctx.strokeStyle = style.border;
  ctx.lineWidth = style.lineWidth;
  ctx.setLineDash([...style.dash]);
  ctx.beginPath();
  ctx.roundRect(inner.x, inner.y, inner.width, inner.height, 24);
  ctx.fill();
  ctx.stroke();
  ctx.setLineDash([]);

  const { lines, productLines, showSwatches, scale } = fitGapText(gap, inner.height, textWidth, (font, text) => {
    ctx.font = font;
    return ctx.measureText(text).width;
  });
  const fonts = gapFonts(scale);
  const lineHeight = style.lineHeight * scale;

  // Centre the block: swatch row, description, product name.
  const swatchSize = showSwatches && gap.swatches.length > 0 ? style.swatchRadius * 2 : 0;
  const swatchGap = swatchSize ? GAP_SPACING.swatch : 0;
  const productGap = productLines.length ? GAP_SPACING.product : 0;
  const blockHeight = swatchSize + swatchGap + lines.length * lineHeight + productGap + productLines.length * lineHeight;
  let y = inner.y + Math.max(0, (inner.height - blockHeight) / 2);
  const cx = inner.x + inner.width / 2;

  if (swatchSize) {
    const r = style.swatchRadius;
    const spacing = r * 2 + 10;
    const startX = cx - ((gap.swatches.length - 1) * spacing) / 2;
    gap.swatches.forEach((colour, i) => {
      ctx.beginPath();
      ctx.arc(startX + i * spacing, y + r, r, 0, Math.PI * 2);
      ctx.fillStyle = colour;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = style.swatchBorder;
      ctx.stroke();
    });
    y += swatchSize + swatchGap;
  }

  ctx.fillStyle = style.text;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = fonts.description;
  for (const line of lines) {
    ctx.fillText(line, cx, y + lineHeight / 2, textWidth);
    y += lineHeight;
  }
  if (productLines.length) {
    y += productGap;
    ctx.font = fonts.product;
    for (const line of productLines) {
      ctx.fillText(line, cx, y + lineHeight / 2, textWidth);
      y += lineHeight;
    }
  }
  ctx.restore();
}

const GAP_SPACING = { swatch: 16, product: 12 } as const;

/** Text size for a gap that doesn't fit at full size. */
const COMPACT_SCALE = 0.8;

function gapFonts(scale: number): { description: string; product: string } {
  const { fontSize, smallFontSize, fontFamily } = COLLAGE_STYLE.gap;
  return {
    description: `500 ${Math.round(fontSize * scale)}px ${fontFamily}`,
    product: `400 ${Math.round(smallFontSize * scale)}px ${fontFamily}`,
  };
}

export interface GapTextFit {
  lines: string[];
  productLines: string[];
  showSwatches: boolean;
  /** 1 for full-size text, COMPACT_SCALE when that was needed to fit. */
  scale: number;
}

/**
 * How much of a gap's text fits its dashed box. The shoes slot is short, so
 * a long description plus a product name may not all fit. In order of
 * preference: more of the text first (3 description lines and 2 product
 * lines, then fewer), each at full size and then smaller; the colour
 * swatches are dropped only as a last resort. `measure(font, text)` is the
 * canvas's measureText. Exported for tests.
 */
export function fitGapText(
  gap: CollageGap,
  availableHeight: number,
  textWidth: number,
  measure: (font: string, text: string) => number,
): GapTextFit {
  const style = COLLAGE_STYLE.gap;
  const hasProduct = gap.productTitle !== null && gap.productTitle.trim() !== "";
  const lineOptions: [number, number][] = hasProduct
    ? [
        [3, 2],
        [3, 1],
        [2, 1],
        [1, 1],
      ]
    : [
        [3, 0],
        [2, 0],
        [1, 0],
      ];
  let smallest: GapTextFit | null = null;
  for (const showSwatches of [true, false]) {
    const swatchHeight = showSwatches && gap.swatches.length > 0 ? style.swatchRadius * 2 + GAP_SPACING.swatch : 0;
    for (const [maxLines, maxProductLines] of lineOptions) {
      for (const scale of [1, COMPACT_SCALE]) {
        const fonts = gapFonts(scale);
        const lines = wrapText(gap.description, textWidth, (t) => measure(fonts.description, t), maxLines);
        const productLines = hasProduct ? wrapText(gap.productTitle!, textWidth, (t) => measure(fonts.product, t), maxProductLines) : [];
        const lineHeight = style.lineHeight * scale;
        const height =
          swatchHeight + lines.length * lineHeight + (productLines.length ? GAP_SPACING.product : 0) + productLines.length * lineHeight;
        const fit = { lines, productLines, showSwatches, scale };
        if (height <= availableHeight) return fit;
        smallest = fit;
      }
    }
  }
  // Nothing fits (a tiny canvas): the smallest layout, centred.
  return smallest!;
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
