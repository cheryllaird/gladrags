/**
 * Typed browser-side client for the wardrobe API routes. Every request body
 * is checked against its contract before it's sent, and every response is
 * parsed with its contract schema, so screens never hand-write API types.
 *
 * Client-safe: imports only from src/contracts.
 */
import type { z } from "zod";
import {
  ApiErrorSchema,
  BatchAddResponseSchema,
  CreateItemRequestSchema,
  EmailImportListResponseSchema,
  DeletedResponseSchema,
  ItemDraftResponseSchema,
  ItemListResponseSchema,
  ItemResponseSchema,
  LinkCutoutMetaSchema,
  LinkImportRequestSchema,
  LinkImportResponseSchema,
  MAX_ITEMS_PER_REVIEW,
  MarkItemsReviewedRequestSchema,
  MarkItemsReviewedResponseSchema,
  OutfitListResponseSchema,
  PHOTO_REPLACE_FIELDS,
  ResetForwardingAddressResponseSchema,
  UPLOAD_FIELDS,
  UpdateItemRequestSchema,
  UpdateSettingsRequestSchema,
  UsageSummarySchema,
  UserSettingsSchema,
  type ApiError,
  type ApiErrorCode,
  type BatchAddResponse,
  type CreateItemRequest,
  type EmailImport,
  type ItemDraft,
  type ItemListQuery,
  type ItemTags,
  type LinkImportResponse,
  type Outfit,
  type ShopId,
  type UsageSummary,
  type UserSettings,
  type WardrobeItem,
} from "@/contracts";

/** Codes from the API, plus two the client adds when it can't get a usable answer. */
export type ClientErrorCode = ApiErrorCode | "network" | "invalid_response";

export class ApiClientError extends Error {
  readonly code: ClientErrorCode;
  readonly status: number | null;
  readonly cap: ApiError["error"]["cap"];
  readonly issues: ApiError["error"]["issues"];

  constructor(
    code: ClientErrorCode,
    message: string,
    options: { status?: number | null; cap?: ApiError["error"]["cap"]; issues?: ApiError["error"]["issues"] } = {},
  ) {
    super(message);
    this.name = "ApiClientError";
    this.code = code;
    this.status = options.status ?? null;
    this.cap = options.cap;
    this.issues = options.issues;
  }
}

// ---------------------------------------------------------------------------
// Signed out (an expired session)
// ---------------------------------------------------------------------------

/** Where to sign in again and come back to `current` (a path plus query string). */
export function signInPath(current: string, reason: "expired" | null = "expired"): string {
  const params = new URLSearchParams();
  if (current && current !== "/" && current.startsWith("/") && !current.startsWith("/sign-in")) {
    params.set("next", current);
  }
  if (reason) params.set("reason", reason);
  const search = params.toString();
  return `/sign-in${search ? `?${search}` : ""}`;
}

/**
 * What happens when any API call answers `unauthorized`: the browser goes
 * to sign-in and comes back here afterwards. The navigation is deferred a
 * tick, so the screen's own catch block runs first (the add flow uses it
 * to keep the item being added). Tests replace `navigate`.
 */
export const unauthorizedRedirect = {
  navigate(url: string): void {
    window.location.assign(url);
  },
};

function goToSignIn(): void {
  if (typeof window === "undefined") return;
  // Path only: the query (a wardrobe search, say) could reach whoever signs
  // in next on this tab. The same user just comes back unfiltered.
  const url = signInPath(window.location.pathname);
  window.setTimeout(() => unauthorizedRedirect.navigate(url), 0);
}

export interface ApiRequestOptions {
  /**
   * Send the user to sign-in when the API answers `unauthorized` (default).
   * The sign-in form turns this off: there, `unauthorized` means a wrong code.
   */
  redirectOnUnauthorized?: boolean;
}

/** Fetch, then parse the success body with `schema` or turn the error body into an ApiClientError. */
export async function apiRequest<T extends z.ZodType>(
  schema: T,
  input: string,
  init?: RequestInit,
  options: ApiRequestOptions = {},
): Promise<z.infer<T>> {
  let response: Response;
  try {
    response = await fetch(input, { credentials: "same-origin", ...init });
  } catch {
    throw new ApiClientError("network", "Couldn't reach GladRags. Check your connection and try again.");
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }

  if (!response.ok) {
    const parsed = ApiErrorSchema.safeParse(body);
    if (parsed.success) {
      const { code, message, cap, issues } = parsed.data.error;
      if (code === "unauthorized" && options.redirectOnUnauthorized !== false) goToSignIn();
      throw new ApiClientError(code, message, { status: response.status, cap, issues });
    }
    throw new ApiClientError("internal", "Something went wrong. Try again.", { status: response.status });
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiClientError("invalid_response", "GladRags sent back something unexpected. Try again.", {
      status: response.status,
    });
  }
  return parsed.data;
}

function jsonInit(method: string, body: unknown): RequestInit {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

/** GET /api/items. Empty filters are left out of the query string. */
export async function listItems(query: ItemListQuery = {}): Promise<WardrobeItem[]> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (typeof value === "string" && value.trim() !== "") params.set(key, value.trim());
    if (typeof value === "boolean") params.set(key, String(value));
  }
  const search = params.toString();
  const { items } = await apiRequest(ItemListResponseSchema, `/api/items${search ? `?${search}` : ""}`);
  return items;
}

export async function getItem(id: string): Promise<WardrobeItem> {
  const { item } = await apiRequest(ItemResponseSchema, `/api/items/${encodeURIComponent(id)}`);
  return item;
}

/** POST /api/items: save a reviewed draft. */
export async function createItem(request: CreateItemRequest): Promise<WardrobeItem> {
  const body = CreateItemRequestSchema.parse(request);
  const { item } = await apiRequest(ItemResponseSchema, "/api/items", jsonInit("POST", body));
  return item;
}

/** PATCH /api/items/:id with the full tag set. */
export async function updateItemTags(id: string, tags: ItemTags): Promise<WardrobeItem> {
  const body = UpdateItemRequestSchema.parse({ tags });
  const { item } = await apiRequest(ItemResponseSchema, `/api/items/${encodeURIComponent(id)}`, jsonInit("PATCH", body));
  return item;
}

/** PATCH /api/items/:id with `{ reviewed: true }`: the suggested tags are right as they are. */
export async function markItemReviewed(id: string): Promise<WardrobeItem> {
  const body = UpdateItemRequestSchema.parse({ reviewed: true });
  const { item } = await apiRequest(ItemResponseSchema, `/api/items/${encodeURIComponent(id)}`, jsonInit("PATCH", body));
  return item;
}

/**
 * POST /api/items/reviewed: "Confirm all". Sent in chunks of
 * MAX_ITEMS_PER_REVIEW; returns how many the server marked.
 */
export async function markItemsReviewed(itemIds: readonly string[]): Promise<number> {
  const unique = [...new Set(itemIds)];
  let updated = 0;
  for (let start = 0; start < unique.length; start += MAX_ITEMS_PER_REVIEW) {
    const body = MarkItemsReviewedRequestSchema.parse({ itemIds: unique.slice(start, start + MAX_ITEMS_PER_REVIEW) });
    const result = await apiRequest(MarkItemsReviewedResponseSchema, "/api/items/reviewed", jsonInit("POST", body));
    updated += result.updated;
  }
  return updated;
}

/** PUT /api/items/:id/photo (multipart): a real photo for an item saved without one (needsPhoto). */
export async function replaceItemPhoto(id: string, original: NamedBlob): Promise<WardrobeItem> {
  const form = new FormData();
  form.append(PHOTO_REPLACE_FIELDS.original, original.blob, original.name);
  const { item } = await apiRequest(ItemResponseSchema, `/api/items/${encodeURIComponent(id)}/photo`, { method: "PUT", body: form });
  return item;
}

export async function deleteItem(id: string): Promise<void> {
  await apiRequest(DeletedResponseSchema, `/api/items/${encodeURIComponent(id)}`, { method: "DELETE" });
}

// ---------------------------------------------------------------------------
// Adding items
// ---------------------------------------------------------------------------

/** A file to upload with the name the server should see. */
export interface NamedBlob {
  blob: Blob;
  name: string;
}

function photoForm(upload: { original: NamedBlob; sourceUrl?: string }, saveForReview: boolean): FormData {
  const form = new FormData();
  form.append(UPLOAD_FIELDS.original, upload.original.blob, upload.original.name);
  if (upload.sourceUrl) form.append(UPLOAD_FIELDS.sourceUrl, upload.sourceUrl);
  if (saveForReview) form.append(UPLOAD_FIELDS.saveForReview, "true");
  return form;
}

/**
 * POST /api/items/photo (multipart): one photo, returned as a draft to
 * review. `sourceUrl` is set for the link screenshot fallback. No cut-out:
 * collages make that later.
 */
export async function uploadPhoto(upload: { original: NamedBlob; sourceUrl?: string }): Promise<ItemDraft> {
  const { draft } = await apiRequest(ItemDraftResponseSchema, "/api/items/photo", { method: "POST", body: photoForm(upload, false) });
  return draft;
}

/** POST /api/items/photo with `saveForReview`: one photo of a batch, saved straight away as "to review" (or a draft if tagging failed). */
export async function uploadPhotoForReview(upload: { original: NamedBlob; sourceUrl?: string }): Promise<BatchAddResponse> {
  return apiRequest(BatchAddResponseSchema, "/api/items/photo", { method: "POST", body: photoForm(upload, true) });
}

/** POST /api/items/link, step 1 of adding by link. */
export async function importLink(url: string): Promise<LinkImportResponse> {
  const body = LinkImportRequestSchema.parse({ url });
  return apiRequest(LinkImportResponseSchema, "/api/items/link", jsonInit("POST", body));
}

function linkStep2Form(originalImageKey: string, saveForReview: boolean): FormData {
  const meta = LinkCutoutMetaSchema.parse(saveForReview ? { originalImageKey, saveForReview: true } : { originalImageKey });
  const form = new FormData();
  form.append(UPLOAD_FIELDS.meta, JSON.stringify(meta));
  return form;
}

/** POST /api/items/link/cutout (multipart), step 2 of adding by link: tag the stored product image. No cut-out is sent. */
export async function finishLink(originalImageKey: string): Promise<ItemDraft> {
  const { draft } = await apiRequest(ItemDraftResponseSchema, "/api/items/link/cutout", {
    method: "POST",
    body: linkStep2Form(originalImageKey, false),
  });
  return draft;
}

/** Step 2 for one link of a batch: saved as "to review" (or a draft if tagging failed). */
export async function finishLinkForReview(originalImageKey: string): Promise<BatchAddResponse> {
  return apiRequest(BatchAddResponseSchema, "/api/items/link/cutout", { method: "POST", body: linkStep2Form(originalImageKey, true) });
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

export async function getUsage(): Promise<UsageSummary> {
  return apiRequest(UsageSummarySchema, "/api/usage");
}

// ---------------------------------------------------------------------------
// Outfits (read only here: the get-started checklist asks whether there are any)
// ---------------------------------------------------------------------------

export async function listOutfits(): Promise<Outfit[]> {
  const { outfits } = await apiRequest(OutfitListResponseSchema, "/api/outfits");
  return outfits;
}

// ---------------------------------------------------------------------------
// Settings and order emails
// ---------------------------------------------------------------------------

export async function getSettings(): Promise<UserSettings> {
  return apiRequest(UserSettingsSchema, "/api/settings");
}

export async function updateFavouriteShops(favouriteShopIds: readonly ShopId[]): Promise<UserSettings> {
  const body = UpdateSettingsRequestSchema.parse({ favouriteShopIds });
  return apiRequest(UserSettingsSchema, "/api/settings", jsonInit("PUT", body));
}

/** A new forwarding address; the old one stops working at once. */
export async function resetForwardingAddress(): Promise<UserSettings> {
  return apiRequest(ResetForwardingAddressResponseSchema, "/api/settings/forwarding-address", { method: "POST" });
}

export async function listEmailImports(): Promise<EmailImport[]> {
  const { imports } = await apiRequest(EmailImportListResponseSchema, "/api/email-imports");
  return imports;
}

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

/** DELETE /api/account: the user's images, items, outfits and account all go. */
export async function deleteAccount(): Promise<void> {
  await apiRequest(DeletedResponseSchema, "/api/account", { method: "DELETE" });
}
