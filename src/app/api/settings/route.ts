// The user's settings: favourite shops and the forwarding address for
// order emails (route contract from foundations, milestone 5; the real
// version is built by link-import with the email import). See
// docs/CONTRACTS.md section 5.
//
// Stub: serves mock data in mock mode only. The real version reads and
// writes the user's user_settings row with the signed-in user's client
// (RLS: own row only; users may change favourite_shop_ids, nothing else),
// and builds the address with forwardingAddress(token, getForwardingAddressConfig()).
import { UpdateSettingsRequestSchema, UserSettingsSchema } from "@/contracts";
import { jsonResponse, parseJsonBody, withApiHandler } from "@/lib/api/http";
import { assertMockModeForStub } from "@/lib/api/stub";
import { requireUser } from "@/lib/auth/session";
import { mockSettings } from "@/lib/mocks/settings";
import * as mock from "@/lib/mocks/store";

export const GET = withApiHandler(async () => {
  await requireUser();
  assertMockModeForStub("Settings");
  return jsonResponse(UserSettingsSchema, mockSettings());
});

/** Change the favourite shops. */
export const PUT = withApiHandler(async (request) => {
  await requireUser();
  const { favouriteShopIds } = await parseJsonBody(request, UpdateSettingsRequestSchema);
  assertMockModeForStub("Settings");
  mock.setFavouriteShops(favouriteShopIds);
  return jsonResponse(UserSettingsSchema, mockSettings());
});
