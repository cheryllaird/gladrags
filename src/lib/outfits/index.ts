/**
 * The outfit engine (owner: outfit-engine). Routes call getOutfitService();
 * see README.md in this folder for how the pipeline works.
 */
import "server-only";
import { getRankingProvider } from "@/lib/ai";
import { describeError } from "@/lib/api/http";
import { isMockMode } from "@/lib/env";
import { getServerImageProcessor } from "@/lib/images/server";
import { createClient } from "@/lib/supabase/server";
import { getUsageGuard } from "@/lib/usage";
import { MockRankingProvider } from "./mock-ranking";
import { MockOutfitRepository } from "./mock-repository";
import { OutfitService } from "./service";
import { SupabaseOutfitRepository } from "./supabase-repository";
import { PlaceholderThumbnailSource, ResizingThumbnailSource, SupabaseImageStore, type ThumbnailSource } from "./thumbnails";

export { OutfitService } from "./service";

/** Thumbnails need the server image processor (built by ingestion). Without it, pass 2 ranks on tags alone. */
function storageThumbnails(client: Awaited<ReturnType<typeof createClient>>): ThumbnailSource {
  try {
    const processor = getServerImageProcessor();
    return new ResizingThumbnailSource(new SupabaseImageStore(client), (image, maxPx) => processor.resize(image, maxPx));
  } catch (error) {
    console.error("No image processor for ranking thumbnails", describeError(error));
    return { getThumbnails: async () => new Map() };
  }
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
