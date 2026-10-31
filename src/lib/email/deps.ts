/**
 * The real dependencies for the order-email routes, outside mock mode.
 * Tests replace this module (vi.mock) with in-memory versions.
 */
import "server-only";
import { getOrderEmailProvider, getTaggingProvider } from "@/lib/ai";
import { getServerImageProcessor } from "@/lib/images/server";
import { SupabaseImageStorage } from "@/lib/ingestion/storage";
import { SupabaseReviewItemStore } from "@/lib/link-import/review-items";
import { systemNetwork } from "@/lib/link-import/safe-fetch";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { getUsageGuard } from "@/lib/usage";
import { placeholderImage } from "./placeholder";
import type { EmailProcessingDeps } from "./process";
import { SupabaseEmailImportReader, SupabaseEmailImportRepository, type EmailImportReader } from "./repository";

/**
 * The webhook has no session, so everything uses the admin client and
 * filters by the user the forwarding token belongs to. Throws ConfigError
 * if Supabase or Gemini isn't configured.
 */
export function getEmailProcessingDeps(): EmailProcessingDeps {
  const admin = createAdminClient();
  return {
    imports: new SupabaseEmailImportRepository(admin),
    usage: getUsageGuard(),
    orderReader: getOrderEmailProvider(),
    tagger: getTaggingProvider(),
    images: getServerImageProcessor(),
    storage: new SupabaseImageStorage(admin),
    reviewItems: new SupabaseReviewItemStore(admin),
    network: systemNetwork,
    placeholder: placeholderImage,
  };
}

/** GET /api/email-imports: the signed-in user's client (RLS: own rows). */
export async function getEmailImportReader(): Promise<EmailImportReader> {
  return new SupabaseEmailImportReader(await createClient());
}
