/**
 * ServerImageProcessor built on sharp (libvips). Server only.
 *
 * sharp drops EXIF, XMP, IPTC and ICC metadata on output unless asked to
 * keep it, so every re-encode below removes location and camera data. The
 * EXIF orientation is applied to the pixels first (rotate()), so photos
 * aren't left sideways once the orientation tag is gone.
 */
import "server-only";
import sharp, { type Metadata, type Sharp } from "sharp";
import type { AcceptedImageType } from "@/contracts";
import type { ImageInput } from "@/lib/ai/types";
import type { ImageInfo, ServerImageProcessor } from "./server";
import { InvalidImageError } from "./server-errors";

/** Plain light grey behind transparent cut-outs sent to a vision model. The tagging prompt mentions it. */
export const MODEL_BACKGROUND = "#e6e6e6";

/**
 * Most pixels sharp will decode. Uploads are at most 1600 px a side, but
 * link-import resizes downloaded product images, which can be larger. The
 * limit stops a small file that claims huge dimensions (a "decompression
 * bomb") from exhausting memory.
 */
const MAX_INPUT_PIXELS = 40_000_000;

const FORMAT_TO_TYPE: Readonly<Record<string, AcceptedImageType>> = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

const JPEG_QUALITY = 85;
const WEBP_QUALITY = 85;

function open(data: Uint8Array): Sharp {
  // One page only: an animated WebP or PNG becomes its first frame.
  return sharp(data, { limitInputPixels: MAX_INPUT_PIXELS, pages: 1 });
}

function encode(pipeline: Sharp, mimeType: AcceptedImageType): Sharp {
  switch (mimeType) {
    case "image/jpeg":
      return pipeline.jpeg({ quality: JPEG_QUALITY, mozjpeg: true });
    case "image/png":
      return pipeline.png({ compressionLevel: 9, effort: 7 });
    case "image/webp":
      return pipeline.webp({ quality: WEBP_QUALITY, alphaQuality: 100 });
  }
}

async function run(pipeline: Sharp, mimeType: AcceptedImageType): Promise<ImageInput> {
  try {
    const buffer = await encode(pipeline, mimeType).toBuffer();
    return { data: new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength), mimeType };
  } catch (error) {
    throw new InvalidImageError(error instanceof Error ? `Couldn't process the image: ${error.message}` : undefined);
  }
}

export class SharpImageProcessor implements ServerImageProcessor {
  async inspect(data: Uint8Array): Promise<ImageInfo> {
    let metadata: Metadata;
    try {
      metadata = await open(data).metadata();
    } catch {
      throw new InvalidImageError();
    }
    const mimeType = metadata.format ? FORMAT_TO_TYPE[metadata.format] : undefined;
    if (!mimeType || !metadata.width || !metadata.height) {
      throw new InvalidImageError("Must be a JPEG, PNG or WebP image");
    }
    return {
      mimeType,
      width: metadata.width,
      height: metadata.height,
      bytes: data.byteLength,
      hasAlpha: metadata.hasAlpha ?? false,
    };
  }

  async hasTransparency(image: ImageInput): Promise<boolean> {
    try {
      const pipeline = open(image.data);
      const { hasAlpha } = await pipeline.metadata();
      if (!hasAlpha) return false;
      const stats = await pipeline.stats();
      return !stats.isOpaque;
    } catch {
      throw new InvalidImageError();
    }
  }

  async stripMetadata(image: ImageInput): Promise<ImageInput> {
    return run(open(image.data).rotate(), image.mimeType);
  }

  async resize(image: ImageInput, maxPx: number): Promise<ImageInput> {
    const pipeline = open(image.data)
      .rotate()
      .resize({ width: maxPx, height: maxPx, fit: "inside", withoutEnlargement: true });
    return run(pipeline, image.mimeType);
  }

  async prepareForModel(image: ImageInput, maxPx: number): Promise<ImageInput> {
    const pipeline = open(image.data)
      .rotate()
      .resize({ width: maxPx, height: maxPx, fit: "inside", withoutEnlargement: true })
      .flatten({ background: MODEL_BACKGROUND });
    return run(pipeline, "image/jpeg");
  }
}
