// The user's settings: favourite shops and the forwarding address for
// order emails (route contract from foundations, milestone 5; built by
// link-import). See docs/CONTRACTS.md section 5, "Settings".
//
// Reads and writes the user's user_settings row with the signed-in user's
// client (RLS: own row only; users may change favourite_shop_ids, nothing
// else). The address is built with forwardingAddress(token,
// getForwardingAddressConfig()), and is null while INBOUND_EMAIL_DOMAIN
// isn't set.
//
// Mock mode serves the mock user's in-memory settings.
import { UpdateSettingsRequestSchema, UserSettingsSchema } from "@/contracts";
import { jsonResponse, parseJsonBody, withApiHandler } from "@/lib/api/http";
import { requireUser } from "@/lib/auth/session";
import { isMockMode } from "@/lib/env";
import { getForwardingAddressConfig } from "@/lib/env.server";
import { mockSettings } from "@/lib/mocks/settings";
import * as mock from "@/lib/mocks/store";
import { getSettingsRepository } from "@/lib/settings/deps";
import { toUserSettings, type StoredSettings } from "@/lib/settings/repository";

/** The row is created with the profile, so a missing one is our bug. */
function present(stored: StoredSettings | null): StoredSettings {
  if (!stored) throw new Error("The user has no settings row");
  return stored;
}

export const GET = withApiHandler(async () => {
  const user = await requireUser();
  if (isMockMode()) return jsonResponse(UserSettingsSchema, mockSettings());
  const config = getForwardingAddressConfig();
  const stored = present(await (await getSettingsRepository()).get(user.id));
  return jsonResponse(UserSettingsSchema, toUserSettings(stored, config));
});

/** Change the favourite shops. */
export const PUT = withApiHandler(async (request) => {
  const user = await requireUser();
  const { favouriteShopIds } = await parseJsonBody(request, UpdateSettingsRequestSchema);
  if (isMockMode()) {
    mock.setFavouriteShops(favouriteShopIds);
    return jsonResponse(UserSettingsSchema, mockSettings());
  }
  const config = getForwardingAddressConfig();
  const stored = present(await (await getSettingsRepository()).setFavouriteShops(user.id, favouriteShopIds));
  return jsonResponse(UserSettingsSchema, toUserSettings(stored, config));
});
