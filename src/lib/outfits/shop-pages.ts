/**
 * "Find in my shops", step 3: confirm each candidate product page the
 * grounded search suggested, and read the product from the page itself.
 *
 * Every page goes through link-import's safe fetcher (SSRF checks, size
 * and time limits) and product parser, the same as add-by-link. A page is
 * kept only if it loads, is still on the same favourite shop's website
 * after redirects, and reads as a product with a title. Title, price and
 * image come from the page, never from the model.
 *
 * Time is bounded: pages are fetched in parallel (SHOP_PAGE_CONCURRENCY at
 * a time) and the whole step has SHOP_PAGE_BUDGET_MS; a page still loading
 * when the budget runs out is dropped.
 */
import "server-only";
import { ShopProductSchema, shopForUrl, type ShopId, type ShopProduct } from "@/contracts";
import { decodeHtml } from "@/lib/link-import/html";
import { PAGE_FETCH } from "@/lib/link-import/import-link";
import { parseProductPrice } from "@/lib/link-import/price";
import { parseProductPage } from "@/lib/link-import/product";
import { SafeFetchError, safeFetch, systemNetwork, type NetworkDeps } from "@/lib/link-import/safe-fetch";
import type { ShopPageChecker, ShopPageCandidate } from "./shop-search";

export class SafeFetchShopPageChecker implements ShopPageChecker {
  constructor(private readonly network: NetworkDeps = systemNetwork) {}

  async check(candidate: ShopPageCandidate, timeoutMs: number): Promise<ShopProduct | null> {
    if (timeoutMs <= 0) return null;
    let page;
    try {
      page = await safeFetch(candidate.url, { ...PAGE_FETCH, totalTimeoutMs: Math.min(PAGE_FETCH.totalTimeoutMs, timeoutMs) }, this.network);
    } catch (error) {
      if (error instanceof SafeFetchError) {
        console.warn("Shop search: page not fetched", { failure: error.failure });
        return null;
      }
      throw error;
    }
    return productFromPage(decodeHtml(page.body, page.contentType), page.finalUrl, candidate.shopId);
  }
}

/**
 * The product on a fetched shop page, or null. Pure. `finalUrl` is where
 * the page came from after redirects: it must still be on `shopId`'s own
 * website (a redirect to another site is dropped).
 */
export function productFromPage(html: string, finalUrl: URL, shopId: ShopId): ShopProduct | null {
  if (shopForUrl(finalUrl.href, [shopId]) === null) return null;
  const parsed = parseProductPage(html, finalUrl);
  if (!parsed.hasProductData || !parsed.product.title) return null;
  const url = new URL(finalUrl.href);
  url.hash = "";
  const product = ShopProductSchema.safeParse({
    shopId,
    title: parsed.product.title,
    url: url.href,
    priceText: parseProductPrice(html),
    // Shown on the product card from the shop's own server, so https only (an http picture on our https page would be blocked).
    imageUrl: parsed.imageUrls.find((u) => u.startsWith("https:")) ?? null,
  });
  return product.success ? product.data : null;
}
