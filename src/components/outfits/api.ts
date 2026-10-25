/**
 * Typed browser client for the outfit routes (docs/CONTRACTS.md, section 5).
 * Request bodies are checked with the contract schemas before sending, and
 * every response is parsed with them on the way back, so the screens only
 * ever see data that matches the contracts.
 *
 * Calls never throw: they return { ok: true, data } or { ok: false, error },
 * where `error` has the API's error shape, so the screens branch on
 * `error.code` alone.
 */
import type { z } from "zod";
import {
  ApiErrorSchema,
  ItemResponseSchema,
  OutfitGenerationResponseSchema,
  OutfitListResponseSchema,
  OutfitRequestSchema,
  OutfitResponseSchema,
  RefineRequestSchema,
  UpdateOutfitStatusRequestSchema,
  type ApiError,
  type OutfitGenerationResponse,
  type OutfitListQuery,
  type OutfitRequestInput,
  type OutfitResponse,
  type RefineRequest,
  type UpdateOutfitStatusRequest,
  type ItemResponse,
  type OutfitListResponse,
} from "@/contracts";

export type ApiFailure = ApiError["error"];
export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiFailure };

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const NETWORK_ERROR: ApiFailure = {
  code: "internal",
  message: "Couldn't reach GladRags. Check your connection and try again.",
};

const UNEXPECTED_RESPONSE: ApiFailure = {
  code: "internal",
  message: "Something went wrong on our side. Please try again.",
};

/** Turn a failed client-side check into the same shape as the API's bad_request. */
function badRequest(error: z.ZodError): ApiResult<never> {
  return {
    ok: false,
    error: {
      code: "bad_request",
      message: error.issues[0]?.message ?? "Check your request and try again.",
      issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    },
  };
}

export function createOutfitsApi(fetchImpl: FetchLike = (input, init) => fetch(input, init)) {
  async function call<S extends z.ZodType>(
    schema: S,
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<ApiResult<z.output<S>>> {
    let response: Response;
    try {
      response = await fetchImpl(path, {
        method: init.method ?? "GET",
        headers: init.body === undefined ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        cache: "no-store",
      });
    } catch {
      return { ok: false, error: NETWORK_ERROR };
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      return { ok: false, error: UNEXPECTED_RESPONSE };
    }

    if (!response.ok) {
      const parsed = ApiErrorSchema.safeParse(json);
      return { ok: false, error: parsed.success ? parsed.data.error : UNEXPECTED_RESPONSE };
    }
    const parsed = schema.safeParse(json);
    return parsed.success ? { ok: true, data: parsed.data } : { ok: false, error: UNEXPECTED_RESPONSE };
  }

  return {
    /** POST /api/outfits */
    requestOutfits(body: OutfitRequestInput): Promise<ApiResult<OutfitGenerationResponse>> {
      const checked = OutfitRequestSchema.safeParse(body);
      if (!checked.success) return Promise.resolve(badRequest(checked.error));
      return call(OutfitGenerationResponseSchema, "/api/outfits", { method: "POST", body: checked.data });
    },

    /** POST /api/outfits/:id/refine: swap one item, or guidance such as "warmer". */
    refineOutfit(outfitId: string, body: RefineRequest): Promise<ApiResult<OutfitGenerationResponse>> {
      const checked = RefineRequestSchema.safeParse(body);
      if (!checked.success) return Promise.resolve(badRequest(checked.error));
      return call(OutfitGenerationResponseSchema, `/api/outfits/${encodeURIComponent(outfitId)}/refine`, {
        method: "POST",
        body: checked.data,
      });
    },

    /** PATCH /api/outfits/:id: save, like, reject (with an optional reason), or back to suggested. */
    setOutfitStatus(outfitId: string, body: UpdateOutfitStatusRequest): Promise<ApiResult<OutfitResponse>> {
      const checked = UpdateOutfitStatusRequestSchema.safeParse(body);
      if (!checked.success) return Promise.resolve(badRequest(checked.error));
      return call(OutfitResponseSchema, `/api/outfits/${encodeURIComponent(outfitId)}`, {
        method: "PATCH",
        body: checked.data,
      });
    },

    /** GET /api/outfits?status= */
    listOutfits(query: OutfitListQuery = {}): Promise<ApiResult<OutfitListResponse>> {
      const params = new URLSearchParams();
      if (query.status) params.set("status", query.status);
      const qs = params.toString();
      return call(OutfitListResponseSchema, `/api/outfits${qs ? `?${qs}` : ""}`);
    },

    /** GET /api/items/:id, for the anchor item. */
    getItem(itemId: string): Promise<ApiResult<ItemResponse>> {
      return call(ItemResponseSchema, `/api/items/${encodeURIComponent(itemId)}`);
    },
  };
}

export type OutfitsApi = ReturnType<typeof createOutfitsApi>;

/** The client the screens use. */
export const outfitsApi: OutfitsApi = createOutfitsApi();
