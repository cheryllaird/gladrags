// Real implementation (foundations): delete the signed-in user's images,
// account and all their data, then sign them out.
import { DeletedResponseSchema } from "@/contracts";
import { jsonResponse, withApiHandler } from "@/lib/api/http";
import { deleteAccount } from "@/lib/auth/delete-account";
import { requireUser } from "@/lib/auth/session";
import { isMockMode } from "@/lib/env";
import { resetMockStore } from "@/lib/mocks/store";
import { createClient } from "@/lib/supabase/server";

export const DELETE = withApiHandler(async () => {
  const user = await requireUser();
  if (isMockMode()) {
    resetMockStore();
    return jsonResponse(DeletedResponseSchema, { deleted: true });
  }
  await deleteAccount(user.id);
  const supabase = await createClient();
  await supabase.auth.signOut();
  return jsonResponse(DeletedResponseSchema, { deleted: true });
});
