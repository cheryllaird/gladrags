// Reset the forwarding address: a new random token, and the old address
// stops working at once (route contract from foundations, milestone 5;
// built by link-import). See docs/CONTRACTS.md section 5.
//
// Stub: serves mock data in mock mode only. The real version calls the
// reset_forwarding_token() database function as the signed-in user.
import { ResetForwardingAddressResponseSchema } from "@/contracts";
import { jsonResponse, withApiHandler } from "@/lib/api/http";
import { assertMockModeForStub } from "@/lib/api/stub";
import { requireUser } from "@/lib/auth/session";
import { mockSettings } from "@/lib/mocks/settings";
import * as mock from "@/lib/mocks/store";

export const POST = withApiHandler(async () => {
  await requireUser();
  assertMockModeForStub("Resetting the forwarding address");
  mock.resetForwardingToken();
  return jsonResponse(ResetForwardingAddressResponseSchema, mockSettings());
});
