/**
 * The real dependencies for the add-by-link routes, outside mock mode.
 * Tests replace this module (vi.mock) with in-memory versions.
 */
import "server-only";
import { getTaggingProvider } from "@/lib/ai";
import { getServerImageProcessor } from "@/lib/images/server";
import { SupabaseImageStorage } from "@/lib/ingestion/storage";
import { SupabaseImageStore } from "@/lib/outfits/thumbnails";
import { createAdminClient } from "@/lib/supabase/admin";
import { getUsageGuard } from "@/lib/usage";
import type { LinkCutoutDeps } from "./finish-link";
import type { LinkImportDeps } from "./import-link";
import { SupabaseLinkImportRepository } from "./repository";
import { systemNetwork } from "./safe-fetch";

/** link_imports is server-only (RLS with no policies), so both steps use the admin client and filter by user ID. */
export function getLinkImportDeps(): LinkImportDeps {
  const admin = createAdminClient();
  return {
    images: getServerImageProcessor(),
    storage: new SupabaseImageStorage(admin),
    linkImports: new SupabaseLinkImportRepository(admin),
    usage: getUsageGuard(),
    network: systemNetwork,
  };
}

export function getLinkCutoutDeps(): LinkCutoutDeps {
  const admin = createAdminClient();
  return {
    images: getServerImageProcessor(),
    storage: new SupabaseImageStorage(admin),
    imageStore: new SupabaseImageStore(admin),
    linkImports: new SupabaseLinkImportRepository(admin),
    tagger: getTaggingProvider(),
    usage: getUsageGuard(),
  };
}
