/**
 * POST /api/items/link, step 1 of 2, the real version (spec: "Add by
 * link"; CONTRACTS.md section 5).
 *
 * Fetch the page safely, read its product data, download the product
 * image safely, clean it (type sniffed from the bytes, fully decoded, EXIF
 * stripped, at most 1600 px), store it as the original, record the import
 * in link_imports and return a 10-minute signed URL so the phone can cut
 * the item out. No AI runs here, so the item cap is only checked; the
 * fetch itself is counted against the link_fetch cap before anything is
 * fetched, so fallbacks count too.
 *
 * Every way of not getting there (blocked, unreachable, not a product
 * page, no usable image) ends in the screenshot fallback, never an error.
 */
import "server-only";
import {
  LINK_IMAGE_URL_TTL_SECONDS,
  MAX_IMAGE_DIMENSION_PX,
  MAX_ORIGINAL_BYTES,
  STORAGE_BUCKETS,
  type LinkImportResponse,
} from "@/contracts";
import type { ImageInput } from "@/lib/ai/types";
import { ApiException } from "@/lib/api/errors";
import { InvalidImageError, sniffImageType, type ServerImageProcessor } from "@/lib/images/server";
import { cleanImage } from "@/lib/ingestion/images";
import { newImageKey, type ImageStorage } from "@/lib/ingestion/storage";
import type { UsageGuard } from "@/lib/usage/guard";
import { decodeHtml } from "./html";
import { parseProductPage } from "./product";
import type { LinkImportRepository } from "./repository";
import { SafeFetchError, safeFetch, systemNetwork, type NetworkDeps, type SafeFetchOptions } from "./safe-fetch";

export interface LinkImportDeps {
  images: ServerImageProcessor;
  storage: ImageStorage;
  linkImports: LinkImportRepository;
  usage: UsageGuard;
  network?: NetworkDeps;
}

/** The product page: HTML only, at most 2 MB. */
export const PAGE_FETCH: SafeFetchOptions = {
  maxBytes: 2 * 1024 * 1024,
  accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
  acceptType: (type) => type === null || /^\s*(text\/html|application\/xhtml\+xml)\s*(;|$)/i.test(type),
  idleTimeoutMs: 5_000,
  totalTimeoutMs: 10_000,
};

/**
 * The product image: at most 10 MB. AVIF, HEIC and GIF aren't asked for
 * and are refused after sniffing the bytes anyway; the content type is
 * only a first filter, since CDNs often send octet-stream.
 */
export const IMAGE_FETCH: SafeFetchOptions = {
  maxBytes: 10 * 1024 * 1024,
  accept: "image/webp,image/jpeg,image/png;q=0.9",
  acceptType: (type) => type === null || /^\s*(image\/[\w.+-]+|application\/octet-stream|binary\/octet-stream)\s*(;|$)/i.test(type),
  idleTimeoutMs: 5_000,
  totalTimeoutMs: 12_000,
};

/** Image URLs to try before giving up. */
export const MAX_IMAGE_ATTEMPTS = 3;

/** Smaller than this on its short side is a logo or tracking pixel, not a product photo. */
export const MIN_PRODUCT_IMAGE_PX = 100;

/** Time for all the image downloads together, so step 1 stays well inside the route's limit. */
export const IMAGE_PHASE_BUDGET_MS = 25_000;

/** Upload field the URL problems are reported on (there is no file field in step 1). */
const URL_FIELD = "url";

const MESSAGES = {
  fetch_blocked: "We couldn't open that page. Take a screenshot of the product and upload it instead.",
  no_product_data: "That page doesn't say which product it is. Take a screenshot of the product and upload it instead.",
  no_image: "We couldn't get a usable picture from that page. Take a screenshot of the product and upload it instead.",
} as const;

function needsScreenshot(reason: keyof typeof MESSAGES, sourceUrl: string): LinkImportResponse {
  return { status: "needs_screenshot", reason, sourceUrl, message: MESSAGES[reason] };
}

export async function importFromLink(deps: LinkImportDeps, userId: string, sourceUrl: string): Promise<LinkImportResponse> {
  // No AI here, but a user at today's limit (or with AI paused) shouldn't
  // be sent through step 2 for nothing. Counting happens in step 2.
  await deps.usage.assertCanStart(userId, "item_ingest");
  // And a limit on how often this user can make the server fetch pages
  // (DAILY_CAPS.link_fetch, per UK day). Counted atomically before any
  // fetch, so fallbacks and failures count too.
  await deps.usage.reserveAction(userId, "link_fetch");
  const network = deps.network ?? systemNetwork;

  let html: string;
  let pageUrl: URL;
  try {
    const page = await safeFetch(sourceUrl, PAGE_FETCH, network);
    html = decodeHtml(page.body, page.contentType);
    pageUrl = page.finalUrl;
  } catch (error) {
    if (!(error instanceof SafeFetchError)) throw error;
    console.warn("Link import: page not fetched", { failure: error.failure });
    return needsScreenshot("fetch_blocked", sourceUrl);
  }

  const parsed = parseProductPage(html, pageUrl);
  if (!parsed.hasProductData) return needsScreenshot("no_product_data", sourceUrl);

  const image = await downloadProductImage(deps.images, parsed.imageUrls, network);
  if (!image) return needsScreenshot("no_image", sourceUrl);

  const originalImageKey = newImageKey(userId, image.mimeType);
  await deps.storage.upload(STORAGE_BUCKETS.originals, originalImageKey, image);
  try {
    await deps.linkImports.create({ userId, sourceUrl, originalImageKey, product: parsed.product });
    const urls = await deps.storage.signedUrls(STORAGE_BUCKETS.originals, [originalImageKey], LINK_IMAGE_URL_TTL_SECONDS);
    const originalUrl = urls.get(originalImageKey);
    if (!originalUrl) throw new Error("Couldn't sign the product image's URL");
    return { status: "ok", sourceUrl, originalImageKey, originalUrl, product: parsed.product };
  } catch (error) {
    // Best effort; the orphaned-image cleanup catches anything left behind.
    await deps.storage.remove(STORAGE_BUCKETS.originals, [originalImageKey]).catch(() => {});
    throw error;
  }
}

/**
 * Try the page's image URLs in order and return the first one that
 * downloads safely and is a real, usable JPEG, PNG or WebP, cleaned and
 * resized. Null if none is.
 */
export async function downloadProductImage(
  images: ServerImageProcessor,
  imageUrls: readonly string[],
  network: NetworkDeps,
  budgetMs: number = IMAGE_PHASE_BUDGET_MS,
): Promise<ImageInput | null> {
  const giveUpAt = Date.now() + budgetMs;
  for (const url of imageUrls.slice(0, MAX_IMAGE_ATTEMPTS)) {
    const remaining = giveUpAt - Date.now();
    if (remaining <= 0) break;
    try {
      const response = await safeFetch(url, { ...IMAGE_FETCH, totalTimeoutMs: Math.min(IMAGE_FETCH.totalTimeoutMs, remaining) }, network);
      const image = await usableImage(images, response.body);
      if (image) return image;
    } catch (error) {
      if (error instanceof SafeFetchError) {
        console.warn("Link import: product image not fetched", { failure: error.failure });
        continue;
      }
      throw error;
    }
  }
  return null;
}

/** Sniffed, decoded, big enough, resized to ≤ 1600 px, EXIF stripped and small enough to store. Null if not. */
async function usableImage(images: ServerImageProcessor, data: Uint8Array): Promise<ImageInput | null> {
  const sniffed = sniffImageType(data);
  if (!sniffed) return null;
  try {
    // inspect sniffs again and reads the header without decoding the pixels.
    const info = await images.inspect(data);
    if (Math.min(info.width, info.height) < MIN_PRODUCT_IMAGE_PX) return null;
    const resized = await images.resize({ data, mimeType: info.mimeType }, MAX_IMAGE_DIMENSION_PX);
    return await cleanImage(images, resized, MAX_ORIGINAL_BYTES, URL_FIELD, "product image");
  } catch (error) {
    // Not a readable image, or too big to store even after shrinking.
    if (error instanceof InvalidImageError || (error instanceof ApiException && error.code === "bad_request")) return null;
    throw error;
  }
}
