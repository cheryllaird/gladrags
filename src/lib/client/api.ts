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
  CreateItemRequestSchema,
  DeletedResponseSchema,
  ItemDraftResponseSchema,
  ItemListResponseSchema,
  ItemResponseSchema,
  LinkCutoutMetaSchema,
  LinkImportRequestSchema,
  LinkImportResponseSchema,
  UPLOAD_FIELDS,
  UpdateItemRequestSchema,
  UsageSummarySchema,
  type ApiError,
  type ApiErrorCode,
  type CreateItemRequest,
  type ItemDraft,
  type ItemListQuery,
  type ItemTags,
  type LinkImportResponse,
  type UsageSummary,
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

/** POST /api/items/photo (multipart). `sourceUrl` is set for the link screenshot fallback. */
export async function uploadPhoto(upload: {
  original: NamedBlob;
  cutout: NamedBlob | null;
  sourceUrl?: string;
}): Promise<ItemDraft> {
  const form = new FormData();
  form.append(UPLOAD_FIELDS.original, upload.original.blob, upload.original.name);
  if (upload.cutout) form.append(UPLOAD_FIELDS.cutout, upload.cutout.blob, upload.cutout.name);
  if (upload.sourceUrl) form.append(UPLOAD_FIELDS.sourceUrl, upload.sourceUrl);
  const { draft } = await apiRequest(ItemDraftResponseSchema, "/api/items/photo", { method: "POST", body: form });
  return draft;
}

/** POST /api/items/link, step 1 of adding by link. */
export async function importLink(url: string): Promise<LinkImportResponse> {
  const body = LinkImportRequestSchema.parse({ url });
  return apiRequest(LinkImportResponseSchema, "/api/items/link", jsonInit("POST", body));
}

/** POST /api/items/link/cutout (multipart), step 2 of adding by link. */
export async function uploadLinkCutout(upload: { originalImageKey: string; cutout: NamedBlob | null }): Promise<ItemDraft> {
  const meta = LinkCutoutMetaSchema.parse({ originalImageKey: upload.originalImageKey });
  const form = new FormData();
  form.append(UPLOAD_FIELDS.meta, JSON.stringify(meta));
  if (upload.cutout) form.append(UPLOAD_FIELDS.cutout, upload.cutout.blob, upload.cutout.name);
  const { draft } = await apiRequest(ItemDraftResponseSchema, "/api/items/link/cutout", { method: "POST", body: form });
  return draft;
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

export async function getUsage(): Promise<UsageSummary> {
  return apiRequest(UsageSummarySchema, "/api/usage");
}

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

/** DELETE /api/account: the user's images, items, outfits and account all go. */
export async function deleteAccount(): Promise<void> {
  await apiRequest(DeletedResponseSchema, "/api/account", { method: "DELETE" });
}
