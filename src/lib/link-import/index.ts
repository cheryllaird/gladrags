/**
 * Add by link (spec: "Add by link"; CONTRACTS.md section 5). Server only.
 *
 * - importFromLink: step 1. Fetch the product page safely, read Open Graph
 *   and schema.org Product JSON-LD, download and clean the product image,
 *   store it, record the import. Falls back to "needs_screenshot".
 * - finishLinkImport: step 2. Check the phone's cut-out, claim the import
 *   once, tag, return the draft.
 * - safeFetch: the SSRF-safe fetcher both use (safe-fetch.ts explains the
 *   checks).
 */
export { blockedAddressReason, isPublicAddress, parseIp } from "./address";
export { LINK_IMPORT_ROW_MAX_AGE_MS, cleanUpOldLinkImports } from "./cleanup";
export { getLinkCutoutDeps, getLinkImportDeps } from "./deps";
export { finishLinkImport, type LinkCutoutDeps } from "./finish-link";
export { IMAGE_FETCH, PAGE_FETCH, importFromLink, type LinkImportDeps } from "./import-link";
export { parseProductPage, type ParsedProductPage } from "./product";
export {
  InMemoryLinkImportRepository,
  SupabaseLinkImportRepository,
  type LinkImportRepository,
  type NewLinkImport,
  type OpenLinkImport,
} from "./repository";
export { SafeFetchError, createSystemNetwork, safeFetch, systemNetwork, type NetworkDeps, type SafeFetchOptions } from "./safe-fetch";
export { UrlPolicyError, checkFetchableUrl } from "./url-policy";
