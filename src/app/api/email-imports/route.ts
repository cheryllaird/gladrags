// The user's recently forwarded order emails and what came of them
// (route contract from foundations, milestone 5; built by link-import).
// See docs/CONTRACTS.md section 5.
//
// Stub: serves mock data in mock mode only. The real version reads the
// user's email_imports rows (RLS: own rows, read-only), newest first.
import { EMAIL_IMPORT_LIST_LIMIT, EmailImportListResponseSchema } from "@/contracts";
import { jsonResponse, withApiHandler } from "@/lib/api/http";
import { assertMockModeForStub } from "@/lib/api/stub";
import { requireUser } from "@/lib/auth/session";
import * as mock from "@/lib/mocks/store";

export const GET = withApiHandler(async () => {
  await requireUser();
  assertMockModeForStub("Order emails");
  return jsonResponse(EmailImportListResponseSchema, { imports: mock.listEmailImports(EMAIL_IMPORT_LIST_LIMIT) });
});
