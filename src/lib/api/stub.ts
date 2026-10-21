import { isMockMode } from "@/lib/env";
import { ApiException } from "./errors";

/**
 * Call in route stubs before serving mock data. Outside mock mode it throws
 * not_implemented, so a deployed build can never serve the shared in-memory
 * mock wardrobe to real users. The owning agent deletes this call when the
 * route gets its real implementation.
 */
export function assertMockModeForStub(route: string): void {
  if (!isMockMode()) {
    throw new ApiException("not_implemented", `${route} isn't built yet`);
  }
}
