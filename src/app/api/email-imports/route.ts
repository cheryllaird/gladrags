// The user's recently forwarded order emails and what came of them
// (route contract from foundations, milestone 5; built by link-import).
// See docs/CONTRACTS.md section 5, "Order emails".
//
// Reads the user's email_imports rows with the signed-in user's client
// (RLS: own rows, read-only), newest first. A row still "processing" long
// after it arrived was cut off, and reads as failed (internal).
import { EMAIL_IMPORT_LIST_LIMIT, EmailImportListResponseSchema } from "@/contracts";
import { jsonResponse, withApiHandler } from "@/lib/api/http";
import { requireUser } from "@/lib/auth/session";
import { getEmailImportReader } from "@/lib/email/deps";
import { isMockMode } from "@/lib/env";
import * as mock from "@/lib/mocks/store";

export const GET = withApiHandler(async () => {
  const user = await requireUser();
  const imports = isMockMode()
    ? mock.listEmailImports(EMAIL_IMPORT_LIST_LIMIT)
    : await (await getEmailImportReader()).list(user.id, EMAIL_IMPORT_LIST_LIMIT);
  return jsonResponse(EmailImportListResponseSchema, { imports });
});
