// Reset the forwarding address: a new random token, and the old address
// stops working at once (route contract from foundations, milestone 5;
// built by link-import). See docs/CONTRACTS.md section 5, "Settings".
//
// Calls the reset_forwarding_token() database function as the signed-in
// user (it acts on auth.uid() only). Mock mode resets the mock user's token.
import { ResetForwardingAddressResponseSchema } from "@/contracts";
import { jsonResponse, withApiHandler } from "@/lib/api/http";
import { requireUser } from "@/lib/auth/session";
import { isMockMode } from "@/lib/env";
import { getForwardingAddressConfig } from "@/lib/env.server";
import { mockSettings } from "@/lib/mocks/settings";
import * as mock from "@/lib/mocks/store";
import { getSettingsRepository } from "@/lib/settings/deps";
import { toUserSettings } from "@/lib/settings/repository";

export const POST = withApiHandler(async () => {
  const user = await requireUser();
  if (isMockMode()) {
    mock.resetForwardingToken();
    return jsonResponse(ResetForwardingAddressResponseSchema, mockSettings());
  }
  const config = getForwardingAddressConfig();
  const stored = await (await getSettingsRepository()).resetForwardingToken(user.id);
  if (!stored) throw new Error("The user has no settings row");
  return jsonResponse(ResetForwardingAddressResponseSchema, toUserSettings(stored, config));
});
