/**
 * Mock mode's "Find in my shops": no network, no cost. The provider
 * answers with three made-up product links per gap, spread over the
 * favourite shops (plus one off-site link, which the real filter drops),
 * and the page checker "reads" each page from its link instead of
 * fetching it. The third product per gap has no picture, so the UI's
 * no-image card gets exercised. The real ShopSearchService runs in
 * between: cap, filter, storing the results.
 */
import { SHOP_PRODUCTS_PER_GAP, ShopProductSchema, type ShopProduct } from "@/contracts";
import type { ModelCall, ShopSearchInput, ShopSearchProvider } from "@/lib/ai/types";
import { MOCK_UPLOAD_IMAGE_URL } from "@/lib/mocks/fixtures";
import type { ShopPageCandidate, ShopPageChecker } from "./shop-search";

function slugOf(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export class MockShopSearchProvider implements ShopSearchProvider {
  readonly name = "mock";

  async searchGaps(input: ShopSearchInput): Promise<ModelCall> {
    const gaps = input.gaps.map((gap) => ({
      category: gap.category,
      candidates: [
        ...Array.from({ length: SHOP_PRODUCTS_PER_GAP }, (_, n) => {
          const shop = input.shops[n % input.shops.length]!;
          return {
            url: `https://www.${shop.domains[0]}/mock-product/${slugOf(gap.description)}-${n}`,
            title: `${gap.description} (${shop.name})`,
          };
        }),
        // Not one of the user's shops: the service drops it.
        { url: `https://shop.example.com/mock-product/${slugOf(gap.description)}`, title: gap.description },
      ],
    }));
    return { raw: { gaps }, costPence: 0, provider: this.name, model: "mock-shop-search" };
  }
}

export class MockShopPageChecker implements ShopPageChecker {
  async check(candidate: ShopPageCandidate): Promise<ShopProduct | null> {
    const n = Number(/-(\d+)$/.exec(new URL(candidate.url).pathname)?.[1] ?? 0);
    const product = ShopProductSchema.safeParse({
      shopId: candidate.shopId,
      title: candidate.title,
      url: candidate.url,
      priceText: `£${25 + n * 10}`,
      imageUrl: n === 2 ? null : MOCK_UPLOAD_IMAGE_URL,
    });
    return product.success ? product.data : null;
  }
}
