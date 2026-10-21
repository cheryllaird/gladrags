import "server-only";
import { STORAGE_BUCKETS } from "@/contracts";
import { createAdminClient } from "@/lib/supabase/admin";

const PAGE_SIZE = 100;

/**
 * Delete a user's images and account (spec: "Users can ... delete their
 * whole account and data"). Deleting the auth user cascades through
 * public.users to items, outfits and feedback (see the core migration).
 * Usage rows are kept, unlinked, so the month's spend still counts.
 */
export async function deleteAccount(userId: string): Promise<void> {
  const admin = createAdminClient();

  for (const bucket of Object.values(STORAGE_BUCKETS)) {
    // Delete page by page; each list call sees what's left.
    for (;;) {
      const { data, error } = await admin.storage.from(bucket).list(userId, { limit: PAGE_SIZE });
      if (error) throw new Error(`Couldn't list ${bucket} images: ${error.message}`);
      if (!data || data.length === 0) break;
      const paths = data.map((file) => `${userId}/${file.name}`);
      const { error: removeError } = await admin.storage.from(bucket).remove(paths);
      if (removeError) throw new Error(`Couldn't delete ${bucket} images: ${removeError.message}`);
      if (data.length < PAGE_SIZE) break;
    }
  }

  const { error } = await admin.auth.admin.deleteUser(userId);
  if (error) throw new Error(`Couldn't delete the account: ${error.message}`);
}
