/**
 * What the daily cleanup runs against: Supabase with the secret key, or
 * empty in-memory stores in mock mode (there's nothing to clean).
 */
import "server-only";
import { InMemorySignInAttemptStore, SupabaseSignInAttemptStore } from "@/lib/auth/rate-limit";
import { isMockMode } from "@/lib/env";
import { InMemoryItemRepository, SupabaseImageReferences } from "@/lib/ingestion/items-repository";
import { InMemoryImageStorage, SupabaseImageStorage } from "@/lib/ingestion/storage";
import { InMemoryLinkImportRepository, SupabaseLinkImportRepository } from "@/lib/link-import/repository";
import { createAdminClient } from "@/lib/supabase/admin";
import type { CleanupJobDeps } from "./cleanup";

export function getCleanupJobDeps(): CleanupJobDeps {
  if (isMockMode()) {
    return {
      storage: new InMemoryImageStorage(),
      references: new InMemoryItemRepository(),
      linkImports: new InMemoryLinkImportRepository(),
      signInAttempts: new InMemorySignInAttemptStore(),
    };
  }
  const admin = createAdminClient();
  return {
    storage: new SupabaseImageStorage(admin),
    references: new SupabaseImageReferences(admin),
    linkImports: new SupabaseLinkImportRepository(admin),
    signInAttempts: new SupabaseSignInAttemptStore(admin),
  };
}
