/**
 * The real dependencies for the ingestion and wardrobe routes, outside mock
 * mode. Tests replace this module (vi.mock) with in-memory versions.
 */
import "server-only";
import { getTaggingProvider } from "@/lib/ai";
import { getServerImageProcessor } from "@/lib/images/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { getUsageGuard } from "@/lib/usage";
import type { PhotoIngestionDeps } from "./add-photo";
import { SupabaseItemRepository } from "./items-repository";
import { SupabaseImageStorage } from "./storage";
import type { WardrobeDeps } from "./wardrobe";

/** Items table as the signed-in user (RLS applies); storage with the admin client. */
export async function getWardrobeDeps(): Promise<WardrobeDeps> {
  return {
    items: new SupabaseItemRepository(await createClient()),
    storage: new SupabaseImageStorage(createAdminClient()),
  };
}

export function getPhotoIngestionDeps(): PhotoIngestionDeps {
  return {
    images: getServerImageProcessor(),
    storage: new SupabaseImageStorage(createAdminClient()),
    tagger: getTaggingProvider(),
    usage: getUsageGuard(),
  };
}
