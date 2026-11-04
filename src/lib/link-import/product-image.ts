/**
 * Finding a product's picture from links someone else supplied: used for
 * the lines of a forwarded order email (CONTRACTS.md section 5, "Order
 * emails", step 6). Same rules as add-by-link, through the same SSRF-safe
 * fetcher: the email's image link first; failing that, the product page,
 * read like an add-by-link page (JSON-LD, then Open Graph) for its images.
 *
 * Never throws for anything the remote side does (blocked, slow, not an
 * image, not a product page): the answer is then `image: null`, and the
 * caller saves the item with a placeholder.
 */
import "server-only";
import type { LinkProduct } from "@/contracts";
import type { ImageInput } from "@/lib/ai/types";
import type { ServerImageProcessor } from "@/lib/images/server";
import { decodeHtml } from "./html";
import { PAGE_FETCH, downloadProductImage } from "./import-link";
import { parseProductPage } from "./product";
import { SafeFetchError, safeFetch, type NetworkDeps } from "./safe-fetch";

export interface ProductImageLinks {
  imageUrl: string | null;
  productUrl: string | null;
}

export interface FoundProductImage {
  /** Cleaned (EXIF stripped, ≤ 1600 px) and ready to store, or null. */
  image: ImageInput | null;
  /** What the product page said, if it was read (for tagging hints). */
  product: LinkProduct | null;
}

/** Most time spent on one line's links, so one slow shop can't use up the email's budget. */
export const LINE_IMAGE_BUDGET_MS = 20_000;

export async function findProductImage(
  images: ServerImageProcessor,
  links: ProductImageLinks,
  network: NetworkDeps,
  budgetMs: number = LINE_IMAGE_BUDGET_MS,
): Promise<FoundProductImage> {
  const giveUpAt = Date.now() + budgetMs;
  const remaining = () => giveUpAt - Date.now();

  if (links.imageUrl) {
    const image = await downloadProductImage(images, [links.imageUrl], network, remaining());
    if (image) return { image, product: null };
  }
  if (!links.productUrl || remaining() <= 0) return { image: null, product: null };

  let html: string;
  let pageUrl: URL;
  try {
    const page = await safeFetch(links.productUrl, { ...PAGE_FETCH, totalTimeoutMs: Math.min(PAGE_FETCH.totalTimeoutMs, remaining()) }, network);
    html = decodeHtml(page.body, page.contentType);
    pageUrl = page.finalUrl;
  } catch (error) {
    if (!(error instanceof SafeFetchError)) throw error;
    console.warn("Order email: product page not fetched", { failure: error.failure });
    return { image: null, product: null };
  }
  const parsed = parseProductPage(html, pageUrl);
  if (!parsed.hasProductData || remaining() <= 0) return { image: null, product: parsed.hasProductData ? parsed.product : null };
  const image = await downloadProductImage(images, parsed.imageUrls, network, remaining());
  return { image, product: parsed.product };
}
