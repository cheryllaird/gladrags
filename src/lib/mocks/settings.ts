import "server-only";
import { forwardingAddress, type UserSettings } from "@/contracts";
import { getForwardingAddressConfig } from "@/lib/env.server";
import * as mock from "./store";

/** The mock user's settings, as GET /api/settings shows them. */
export function mockSettings(): UserSettings {
  const { favouriteShopIds, forwardingToken } = mock.getSettings();
  const config = getForwardingAddressConfig();
  return { favouriteShopIds, forwardingAddress: config ? forwardingAddress(forwardingToken, config) : null };
}
