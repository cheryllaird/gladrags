/**
 * The outfit routes with mock mode OFF: the real wiring (Supabase
 * repository, storage thumbnails, ranking provider factory, usage guard)
 * with Supabase replaced by an in-memory fake, the ranking model by
 * recorded-style replies, and usage by an in-memory store. No network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  API_ERROR_STATUS,
  ApiErrorSchema,
  OutfitGenerationResponseSchema,
  OutfitListResponseSchema,
  OutfitResponseSchema,
  type ApiErrorCode,
  type Outfit,
} from "@/contracts";
import { FakeRankingProvider } from "@/lib/ai/fakes";
import type { RankingProvider } from "@/lib/ai/types";
import { ConfigError } from "@/lib/env";
import { InMemoryUsageStore, MONTHLY_AI_SPEND_CAP_PENCE } from "@/lib/usage";
import { FakeSupabase } from "@/test/fake-supabase";
import { finalReplies, shortlistReplies, W, WARDROBE } from "@/test/fixtures/outfit-engine";
import { COLOUR_RGB, swatchPng } from "@/test/fixtures/swatch-png";
import { toItemRow } from "@/test/outfit-helpers";

const USER = { id: "0c000000-0000-4000-8000-000000000003", email: "tester@example.com" };
const OTHER = "0c000000-0000-4000-8000-000000000004";

const fake = vi.hoisted(() => ({
  db: null as unknown as FakeSupabase,
  user: null as { id: string; email: string } | null,
  ranking: null as unknown as () => RankingProvider,
  usage: null as unknown as InMemoryUsageStore,
  resized: [] as number[],
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () =>
    Object.assign(fake.db, { auth: { getUser: async () => ({ data: { user: fake.user } }) } }),
}));
vi.mock("@/lib/ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai")>()),
  getRankingProvider: () => fake.ranking(),
}));
vi.mock("@/lib/usage", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/usage")>();
  return { ...original, getUsageGuard: () => new original.UsageGuard(fake.usage) };
});
vi.mock("@/lib/images/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/images/server")>()),
  getServerImageProcessor: () => ({
    resize: async (image: { data: Uint8Array }, maxPx: number) => {
      fake.resized.push(maxPx);
      return image;
    },
  }),
}));

import * as refine from "./[id]/refine/route";
import * as outfitById from "./[id]/route";
import * as outfits from "./route";

const BASE = "http://localhost:3000";
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const json = (path: string, method: string, body?: unknown) =>
  new Request(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function expectError(response: Response, code: ApiErrorCode) {
  expect(response.status).toBe(API_ERROR_STATUS[code]);
  const body = ApiErrorSchema.parse(await response.json());
  expect(body.error.code).toBe(code);
  return body.error;
}

let ranking: FakeRankingProvider;

beforeEach(() => {
  vi.stubEnv("GLADRAGS_MOCK_MODE", "false");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://qa-project.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_qa");
  fake.db = new FakeSupabase();
  fake.user = USER;
  fake.usage = new InMemoryUsageStore();
  fake.resized = [];
  ranking = new FakeRankingProvider({ shortlist: [shortlistReplies.valid], final: [finalReplies.valid] });
  fake.ranking = () => ranking;
  for (const item of WARDROBE) {
    const row = toItemRow(item, USER.id);
    fake.db.tables.items!.push(row);
    fake.db.objects.set(`cutouts/${row.cutout_image_key}`, swatchPng(COLOUR_RGB.navy));
  }
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function generate(body: unknown = { style: { kind: "preset", presetId: "work" }, count: 3 }) {
  const res = await outfits.POST(json("/api/outfits", "POST", body));
  expect(res.status).toBe(200);
  const parsed = OutfitGenerationResponseSchema.parse(await res.json());
  if (parsed.status !== "ok") throw new Error(`expected outfits, got ${parsed.reason}`);
  return parsed.outfits;
}

describe("POST /api/outfits (real pipeline, mock mode off)", () => {
  it("ranks in two passes and saves the outfits for this user", async () => {
    const result = await generate();
    expect(result.map((o) => o.name)).toEqual(finalReplies.valid.outfits.map((o) => o.name));
    expect(result[0]!.items[0]!.cutoutUrl).toMatch(/^https:\/\/signed\.test\/cutouts\//);
    expect(fake.db.tables.outfits).toHaveLength(3);
    expect(fake.db.tables.outfits!.every((r) => r.user_id === USER.id && r.status === "suggested")).toBe(true);

    // Pass 2 got ~256 px thumbnails made from the stored cut-outs.
    expect(ranking.finalCalls[0]!.shortlist[0]!.thumbnails.length).toBeGreaterThan(0);
    expect(new Set(fake.resized)).toEqual(new Set([256]));

    // One outfit request counted, and both model calls costed.
    expect(fake.usage.events.map((e) => e.kind)).toEqual(["outfit_request", "ranking_shortlist", "ranking_final"]);
  });

  it("ignores mock markers outside mock mode", async () => {
    await generate({ style: { kind: "preset", presetId: "work" }, guidance: "mock-ai-paused", count: 3 });
  });

  it("returns 502 ai_failed when the model's replies are invalid twice", async () => {
    ranking = new FakeRankingProvider({ shortlist: [shortlistReplies.prose], final: [finalReplies.valid] });
    await expectError(await outfits.POST(json("/api/outfits", "POST", { style: { kind: "preset", presetId: "work" } })), "ai_failed");
    expect(fake.db.tables.outfits).toEqual([]);
  });

  it("returns 503 ai_paused when the monthly cap is reached", async () => {
    await fake.usage.record({ userId: null, kind: "tagging", costPence: MONTHLY_AI_SPEND_CAP_PENCE, provider: "gemini" });
    const error = await expectError(await outfits.POST(json("/api/outfits", "POST", { style: { kind: "preset", presetId: "work" } })), "ai_paused");
    expect(error.cap?.kind).toBe("monthly_ai_spend");
  });

  it("returns 500 server_misconfigured when the Gemini key is missing", async () => {
    fake.ranking = () => {
      throw new ConfigError("Gemini is not configured. Check: GEMINI_API_KEY. See .env.example.");
    };
    const error = await expectError(await outfits.POST(json("/api/outfits", "POST", { style: { kind: "preset", presetId: "work" } })), "server_misconfigured");
    expect(error.message).not.toMatch(/GEMINI/);
    expect(fake.usage.events).toEqual([]); // not counted, no model call recorded
  });

  it("still answers an empty wardrobe without the Gemini key (no AI needed)", async () => {
    fake.ranking = () => {
      throw new ConfigError("Gemini is not configured.");
    };
    fake.db.tables.items = fake.db.tables.items!.filter((r) => r.user_id !== USER.id);
    const res = await outfits.POST(json("/api/outfits", "POST", { style: { kind: "preset", presetId: "work" } }));
    expect(OutfitGenerationResponseSchema.parse(await res.json())).toMatchObject({
      status: "incomplete_wardrobe",
      reason: "empty_wardrobe",
      missingCategories: [],
    });
  });

  it("lists outfits without touching the image processor or Gemini", async () => {
    fake.ranking = () => {
      throw new Error("must not be created");
    };
    const res = await outfits.GET(json("/api/outfits", "GET"));
    expect(res.status).toBe(200);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("returns 404 for another user's item as the anchor", async () => {
    fake.db.tables.items!.push({ ...toItemRow(WARDROBE[0]!, OTHER), id: "2b000000-0000-4000-8000-0000000000ff" });
    const res = await outfits.POST(
      json("/api/outfits", "POST", { style: { kind: "preset", presetId: "work" }, anchorItemId: "2b000000-0000-4000-8000-0000000000ff" }),
    );
    await expectError(res, "not_found");
  });

  it("needs a signed-in user", async () => {
    fake.user = null;
    await expectError(await outfits.POST(json("/api/outfits", "POST", { style: { kind: "preset", presetId: "work" } })), "unauthorized");
    await expectError(await outfits.GET(json("/api/outfits", "GET")), "unauthorized");
  });
});

describe("list, get, status and refine (mock mode off)", () => {
  let first: Outfit;

  beforeEach(async () => {
    [first] = (await generate()) as [Outfit];
  });

  it("lists and gets the user's outfits; another user's is not found", async () => {
    const list = OutfitListResponseSchema.parse(await (await outfits.GET(json("/api/outfits", "GET"))).json());
    expect(list.outfits).toHaveLength(3);
    const one = OutfitResponseSchema.parse(await (await outfitById.GET(json(`/api/outfits/${first.id}`, "GET"), ctx(first.id))).json());
    expect(one.outfit.id).toBe(first.id);

    fake.user = { id: OTHER, email: "other@example.com" };
    await expectError(await outfitById.GET(json(`/api/outfits/${first.id}`, "GET"), ctx(first.id)), "not_found");
    await expectError(await outfitById.PATCH(json(`/api/outfits/${first.id}`, "PATCH", { status: "saved" }), ctx(first.id)), "not_found");
  });

  it("rejecting records feedback, and the pairing is an avoid hint next time", async () => {
    const res = await outfitById.PATCH(json(`/api/outfits/${first.id}`, "PATCH", { status: "rejected", reason: "too plain" }), ctx(first.id));
    expect(OutfitResponseSchema.parse(await res.json()).outfit.status).toBe("rejected");
    expect(fake.db.tables.outfit_feedback).toEqual([
      expect.objectContaining({ outfit_id: first.id, user_id: USER.id, kind: "reject", detail: "too plain" }),
    ]);

    ranking = new FakeRankingProvider({ shortlist: [shortlistReplies.valid], final: [finalReplies.valid] });
    await outfits.POST(json("/api/outfits", "POST", { style: { kind: "preset", presetId: "work" }, count: 3 }));
    const hints = ranking.shortlistCalls[0]!.avoidPairs.map((p) => [...p].sort().join());
    expect(hints).toContain([W.top1, W.bottom1].sort().join());
  });

  it("undoing a reject (PATCH suggested) removes the avoid hint; the feedback row stays", async () => {
    await outfitById.PATCH(json(`/api/outfits/${first.id}`, "PATCH", { status: "rejected" }), ctx(first.id));
    const undo = await outfitById.PATCH(json(`/api/outfits/${first.id}`, "PATCH", { status: "suggested" }), ctx(first.id));
    expect(OutfitResponseSchema.parse(await undo.json()).outfit.status).toBe("suggested");

    ranking = new FakeRankingProvider({ shortlist: [shortlistReplies.valid], final: [finalReplies.valid] });
    await outfits.POST(json("/api/outfits", "POST", { style: { kind: "preset", presetId: "work" }, count: 3 }));
    expect(ranking.shortlistCalls[0]!.avoidPairs).toEqual([]);
    expect(fake.db.tables.outfit_feedback).toEqual([expect.objectContaining({ outfit_id: first.id, kind: "reject", detail: null })]);
  });

  it("refines by swap: stores parent_outfit_id and swap feedback", async () => {
    ranking = new FakeRankingProvider({
      shortlist: [{}],
      final: [{ outfits: [{ itemIds: [W.top1, W.bottom1, W.shoes2], name: "New shoes", reason: "Swapped the loafers" }] }],
    });
    const res = await refine.POST(json(`/api/outfits/${first.id}/refine`, "POST", { kind: "swap", itemId: W.shoes1 }), ctx(first.id));
    const body = OutfitGenerationResponseSchema.parse(await res.json());
    expect(body.status).toBe("ok");
    if (body.status !== "ok") return;
    expect(body.outfits[0]!.parentOutfitId).toBe(first.id);
    expect(fake.db.tables.outfits!.at(-1)!.parent_outfit_id).toBe(first.id);
    expect(fake.db.tables.outfit_feedback).toEqual([expect.objectContaining({ kind: "swap", detail: W.shoes1 })]);
    expect(fake.usage.events.filter((e) => e.kind === "outfit_request")).toHaveLength(2);
  });

  it("refines by guidance", async () => {
    ranking = new FakeRankingProvider({
      shortlist: [{ outfits: [{ itemIds: [W.top2, W.bottom2, W.shoes1, W.coat] }, { itemIds: [W.dress, W.shoes2, W.coat] }] }],
      final: [{ outfits: [{ itemIds: [W.dress, W.shoes2, W.coat], name: "Warmer", reason: "The coat adds warmth" }] }],
    });
    const res = await refine.POST(json(`/api/outfits/${first.id}/refine`, "POST", { kind: "guidance", text: "warmer" }), ctx(first.id));
    const body = OutfitGenerationResponseSchema.parse(await res.json());
    expect(body.status === "ok" && body.outfits[0]!.request.guidance).toBe("warmer");
    expect(fake.db.tables.outfit_feedback).toEqual([expect.objectContaining({ kind: "guidance", detail: "warmer" })]);
  });
});

describe("AI pausing mid-request (another request takes the month to the cap)", () => {
  /** Fill the month's spend right after this request's outfit_request is counted. */
  function pauseAfterCounting() {
    const reserve = fake.usage.reserve.bind(fake.usage);
    vi.spyOn(fake.usage, "reserve").mockImplementation(async (request) => {
      const result = await reserve(request);
      if (request.kind === "outfit_request") {
        await fake.usage.record({ userId: null, kind: "tagging", costPence: MONTHLY_AI_SPEND_CAP_PENCE, provider: "gemini" });
      }
      return result;
    });
  }

  it("answers ai_paused, makes no model call, and gives today's count back", async () => {
    pauseAfterCounting();
    await expectError(await outfits.POST(json("/api/outfits", "POST", { style: { kind: "preset", presetId: "work" }, count: 3 })), "ai_paused");
    expect(ranking.shortlistCalls).toHaveLength(0);
    expect(ranking.finalCalls).toHaveLength(0);
    expect(fake.usage.events.filter((e) => e.kind === "outfit_request")).toHaveLength(0);
    expect(fake.db.tables.outfits ?? []).toHaveLength(0);
  });

  it("a different failure after counting (the model fails twice) keeps the count", async () => {
    ranking = new FakeRankingProvider({ shortlist: ["not json", "not json"], final: ["not json", "not json"] });
    fake.ranking = () => ranking;
    await expectError(await outfits.POST(json("/api/outfits", "POST", { style: { kind: "preset", presetId: "work" }, count: 3 })), "ai_failed");
    expect(fake.usage.events.filter((e) => e.kind === "outfit_request")).toHaveLength(1);
  });
});
