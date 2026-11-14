/**
 * Round 2: turning a checked generated image into the stored preview, and
 * reading a picked shop product's picture for the image model. Server only
 * (sharp, and the safe fetcher).
 *
 * Stored previews (CONTRACTS.md sections 6 and 12): WebP, no metadata,
 * exactly 2:3 (padded with the picture's own background colour when the
 * model's ratio is inside the tolerance but not exact), longest side at
 * most PREVIEW_STORED_MAX_SIDE_PX, at most PREVIEW_STORED_MAX_BYTES.
 */
import "server-only";
import sharp from "sharp";
import {
  PREVIEW_ASPECT_RATIO,
  PREVIEW_DECODE_MAX_INPUT_PIXELS,
  PREVIEW_STORED_IMAGE_TYPE,
  PREVIEW_STORED_MAX_BYTES,
  PREVIEW_STORED_MAX_SIDE_PX,
  shopImageUrlAllowed,
  type ShopProduct,
} from "@/contracts";
import type { ImageInput } from "@/lib/ai/types";
import { InvalidImageError, sniffImageType } from "@/lib/images/server";
import { IMAGE_FETCH, MIN_PRODUCT_IMAGE_PX } from "@/lib/link-import/import-link";
import { SafeFetchError, safeFetch, systemNetwork, type NetworkDeps, type SafeFetchOptions, type SafeFetchResult } from "@/lib/link-import/safe-fetch";
import { PREVIEW_INPUT_IMAGE_PX, type ProductImageFetcher } from "./preview";

/** WebP qualities tried in turn until the file fits PREVIEW_STORED_MAX_BYTES. */
const WEBP_QUALITIES = [85, 72, 60] as const;

/** The exact 2:3 size (width, height) a w × h picture is padded to: the smallest that holds it. */
export function paddedPortraitSize(width: number, height: number): { width: number; height: number } {
  const { width: rw, height: rh } = PREVIEW_ASPECT_RATIO;
  const unit = Math.max(Math.ceil(width / rw), Math.ceil(height / rh));
  return { width: unit * rw, height: unit * rh };
}

/** The exact 2:3 size the stored image is scaled to: the padded size, shrunk to fit PREVIEW_STORED_MAX_SIDE_PX. */
export function storedPortraitSize(padded: { width: number; height: number }): { width: number; height: number } {
  const { width: rw, height: rh } = PREVIEW_ASPECT_RATIO;
  const maxUnit = Math.floor(PREVIEW_STORED_MAX_SIDE_PX / Math.max(rw, rh));
  const unit = Math.min(padded.width / rw, maxUnit);
  return { width: unit * rw, height: unit * rh };
}

/**
 * Re-encode a generated image (already checked by checkGeneratedPreviewImage)
 * for storage. Throws if it can't (the preview then fails as internal).
 */
export async function encodePreviewForStorage(data: Uint8Array): Promise<ImageInput> {
  const options = { limitInputPixels: PREVIEW_DECODE_MAX_INPUT_PIXELS, failOn: "error" as const };
  const { data: raw, info } = await sharp(data, options).rotate().removeAlpha().raw().toBuffer({ resolveWithObject: true });
  // The model is asked for a plain background: pad with the colour of the top-left pixel.
  const background = { r: raw[0] ?? 255, g: raw[1] ?? 255, b: raw[2] ?? 255 };
  const padded = paddedPortraitSize(info.width, info.height);
  const left = Math.floor((padded.width - info.width) / 2);
  const top = Math.floor((padded.height - info.height) / 2);
  const target = storedPortraitSize(padded);

  // Two pipelines: within one, sharp resizes before it extends.
  const paddedRaw = await sharp(raw, { raw: { width: info.width, height: info.height, channels: info.channels } })
    .extend({ left, right: padded.width - info.width - left, top, bottom: padded.height - info.height - top, background })
    .raw()
    .toBuffer();
  for (const quality of WEBP_QUALITIES) {
    const out = await sharp(paddedRaw, { raw: { width: padded.width, height: padded.height, channels: info.channels } })
      .resize(target.width, target.height, { fit: "fill" })
      .webp({ quality })
      .toBuffer();
    if (out.byteLength <= PREVIEW_STORED_MAX_BYTES) {
      return { data: new Uint8Array(out.buffer, out.byteOffset, out.byteLength), mimeType: PREVIEW_STORED_IMAGE_TYPE };
    }
  }
  throw new Error("The preview is too big to store even at the lowest quality");
}

// ---------------------------------------------------------------------------
// A picked shop product's picture, for the image model
// ---------------------------------------------------------------------------

/** The image checks for a downloaded picture: header read, then a small model-ready JPEG (which fully decodes it). */
export interface ProductImageProcessor {
  inspect(data: Uint8Array): Promise<{ width: number; height: number; mimeType: ImageInput["mimeType"] }>;
  prepareForModel(image: ImageInput, maxPx: number): Promise<ImageInput>;
}

type Fetch = (url: string, options: SafeFetchOptions, network: NetworkDeps) => Promise<SafeFetchResult>;

/**
 * Through link-import's safe fetcher (SSRF checks, size and time limits),
 * with the picture's address and every redirect limited to the shop's own
 * domains or its listed image hosts (shopImageUrlAllowed). The picture is
 * model input only: never stored or shown.
 */
export class SafeFetchProductImageFetcher implements ProductImageFetcher {
  constructor(
    private readonly images: ProductImageProcessor,
    private readonly network: NetworkDeps = systemNetwork,
    private readonly fetchImpl: Fetch = safeFetch,
  ) {}

  async fetch(product: ShopProduct, timeoutMs: number): Promise<ImageInput | null> {
    const url = product.imageUrl;
    if (!url || timeoutMs <= 0) return null;
    if (!shopImageUrlAllowed(url, product.shopId)) {
      console.warn("Preview: shop picture not on the shop's own hosts; described in words", { shopId: product.shopId });
      return null;
    }
    let body: Uint8Array;
    try {
      const response = await this.fetchImpl(
        url,
        {
          ...IMAGE_FETCH,
          totalTimeoutMs: Math.min(IMAGE_FETCH.totalTimeoutMs, timeoutMs),
          allowRedirect: (target) => shopImageUrlAllowed(target.href, product.shopId),
        },
        this.network,
      );
      body = response.body;
    } catch (error) {
      if (error instanceof SafeFetchError) {
        console.warn("Preview: shop picture not fetched; described in words", { failure: error.failure });
        return null;
      }
      throw error;
    }
    if (!sniffImageType(body)) return null;
    try {
      const info = await this.images.inspect(body);
      if (Math.min(info.width, info.height) < MIN_PRODUCT_IMAGE_PX) return null;
      return await this.images.prepareForModel({ data: body, mimeType: info.mimeType }, PREVIEW_INPUT_IMAGE_PX);
    } catch (error) {
      if (error instanceof InvalidImageError) return null;
      throw error;
    }
  }
}
