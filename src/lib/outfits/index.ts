/**
 * The outfit engine (owner: outfit-engine). Routes call getOutfitService();
 * see README.md in this folder for how the pipeline works.
 */
import "server-only";
import { getRankingProvider, getShopSearchProvider } from "@/lib/ai";
import { describeError } from "@/lib/api/http";
import { isMockMode } from "@/lib/env";
import { getServerImageProcessor } from "@/lib/images/server";
import { createClient } from "@/lib/supabase/server";
import { getUsageGuard } from "@/lib/usage";
import { MockRankingProvider } from "./mock-ranking";
import { MockOutfitRepository } from "./mock-repository";
import { MockShopPageChecker, MockShopSearchProvider } from "./mock-shop-search";
import { OutfitService } from "./service";
import { SafeFetchShopPageChecker } from "./shop-pages";
import { ShopSearchService } from "./shop-search";
import { SupabaseOutfitRepository } from "./supabase-repository";
import { PlaceholderThumbnailSource, ResizingThumbnailSource, SupabaseImageStore, type ThumbnailSource } from "./thumbnails";

export { OutfitService } from "./service";
export { ShopSearchService } from "./shop-search";

/**
 * Thumbnails need the server image processor (built by ingestion). It's
 * looked up only when pass 2 needs pictures; without it, pass 2 ranks on
 * the shortlist alone rather than failing the request.
 */
function storageThumbnails(client: Awaited<ReturnType<typeof createClient>>): ThumbnailSource {
  return {
    async getThumbnails(items) {
      let resize;
      try {
        const processor = getServerImageProcessor();
        resize = processor.resize.bind(processor);
      } catch (error) {
        console.error("No image processor for ranking thumbnails", describeError(error));
        return new Map();
      }
      return new ResizingThumbnailSource(new SupabaseImageStore(client), resize).getThumbnails(items);
    },
  };
}

/**
 * The outfit service for this request. Mock mode: the in-memory wardrobe,
 * a mock ranking model and placeholder thumbnails (no network). Otherwise:
 * Supabase as the signed-in user, and Gemini.
 */
export async function getOutfitService(): Promise<OutfitService> {
  const usage = getUsageGuard();
  if (isMockMode()) {
    return new OutfitService({
      repository: new MockOutfitRepository(),
      ranking: () => new MockRankingProvider(),
      thumbnails: new PlaceholderThumbnailSource(),
      usage,
    });
  }
  const client = await createClient();
  return new OutfitService({
    repository: new SupabaseOutfitRepository(client),
    ranking: getRankingProvider,
    thumbnails: storageThumbnails(client),
    usage,
  });
}

/**
 * "Find in my shops" and choosing a gap's product. Mock mode: canned
 * products from the favourite shops, no network. Otherwise: Supabase as the
 * signed-in user, Gemini with Google Search, and link-import's safe fetcher
 * for the product pages.
 */
export async function getShopSearchService(): Promise<ShopSearchService> {
  const usage = getUsageGuard();
  if (isMockMode()) {
    return new ShopSearchService({
      repository: new MockOutfitRepository(),
      usage,
      provider: () => new MockShopSearchProvider(),
      pages: new MockShopPageChecker(),
    });
  }
  const client = await createClient();
  return new ShopSearchService({
    repository: new SupabaseOutfitRepository(client),
    usage,
    provider: getShopSearchProvider,
    pages: new SafeFetchShopPageChecker(),
  });
}
