/**
 * "Find in my shops" and choosing a gap's product through the routes, mock
 * mode OFF: the real wiring with Supabase replaced by an in-memory fake,
 * Gemini by a recorded-style grounded reply, the product pages by a fake
 * checker, and usage by an in-memory store. Also a whole journey: a
 * wardrobe without shoes gets outfits with a shoes gap, saved with the
 * gaps, which can then be searched. No network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  API_ERROR_STATUS,
  ApiErrorSchema,
  OutfitGenerationResponseSchema,
  OutfitResponseSchema,
  type ApiErrorCode,
  type ShopProduct,
} from "@/contracts";
import { FakeRankingProvider } from "@/lib/ai/fakes";
import { GeminiShopSearchProvider } from "@/lib/ai/gemini-shop-search";
import type { RankingProvider, ShopSearchProvider } from "@/lib/ai/types";
import type { ShopPageCandidate } from "@/lib/outfits/shop-search";
import { InMemoryUsageStore } from "@/lib/usage";
import { FakeSupabase } from "@/test/fake-supabase";
import { NO_SHOES, noShoesReplies } from "@/test/fixtures/outfit-engine";
import { shopSearchReply } from "@/test/fixtures/shop-search";
import { COLOUR_RGB, swatchPng } from "@/test/fixtures/swatch-png";
import { toItemRow } from "@/test/outfit-helpers";

const USER = { id: "0c000000-0000-4000-8000-000000000003", email: "tester@example.com" };
const OTHER = { id: "0c000000-0000-4000-8000-000000000004", email: "other@example.com" };

const fake = vi.hoisted(() => ({
  db: null as unknown as FakeSupabase,
  user: null as { id: string; email: string } | null,
  ranking: null as unknown as () => RankingProvider,
  shopSearch: null as unknown as () => ShopSearchProvider,
  usage: null as unknown as InMemoryUsageStore,
  checked: [] as { url: string; shopId: string }[],
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => Object.assign(fake.db, { auth: { getUser: async () => ({ data: { user: fake.user } }) } }),
}));
vi.mock("@/lib/ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai")>()),
  getRankingProvider: () => fake.ranking(),
  getShopSearchProvider: () => fake.shopSearch(),
}));
vi.mock("@/lib/usage", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/usage")>();
  return { ...original, getUsageGuard: () => new original.UsageGuard(fake.usage) };
});
vi.mock("@/lib/images/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/images/server")>()),
  getServerImageProcessor: () => ({ resize: async (image: unknown) => image }),
}));
vi.mock("@/lib/outfits/shop-pages", () => ({
  SafeFetchShopPageChecker: class {
    async check(candidate: ShopPageCandidate): Promise<ShopProduct | null> {
      fake.checked.push({ url: candidate.url, shopId: candidate.shopId });
      return { shopId: candidate.shopId, title: `From the page ${new URL(candidate.url).pathname}`, url: candidate.url, priceText: "£40", imageUrl: null };
    }
  },
}));

import * as gapProduct from "./[id]/gaps/[category]/route";
import * as shopSearch from "./[id]/shop-search/route";
import * as outfits from "./route";

const BASE = "http://localhost:3000";
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const gapCtx = (id: string, category: string) => ({ params: Promise.resolve({ id, category }) });
const json = (path: string, method: string, body?: unknown) =>
  new Request(`${BASE}${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

async function expectError(response: Response, code: ApiErrorCode) {
  expect(response.status).toBe(API_ERROR_STATUS[code]);
  expect(ApiErrorSchema.parse(await response.json()).error.code).toBe(code);
}

let geminiCalls: number;

beforeEach(() => {
  vi.stubEnv("GLADRAGS_MOCK_MODE", "false");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://qa-project.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_qa");
  fake.db = new FakeSupabase();
  fake.user = USER;
  fake.usage = new InMemoryUsageStore();
  fake.checked = [];
  geminiCalls = 0;
  fake.ranking = () => new FakeRankingProvider({ shortlist: [noShoesReplies.shortlist], final: [noShoesReplies.final] });
  fake.shopSearch = () =>
    new GeminiShopSearchProvider({
      async generateContent() {
        geminiCalls++;
        return { text: shopSearchReply("trainers-and-jacket") };
      },
    });
  fake.db.tables.user_settings = [
    { user_id: USER.id, favourite_shop_ids: ["next", "marks_and_spencer", "new_look"], forwarding_token: "0123456789abcdef0123456789abcdef", updated_at: "2026-10-30 10:00:00+00" },
  ];
  for (const item of NO_SHOES) {
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

async function gapOutfits() {
  const res = await outfits.POST(json("/api/outfits", "POST", { style: { kind: "preset", presetId: "work" }, count: 3 }));
  const body = OutfitGenerationResponseSchema.parse(await res.json());
  if (body.status !== "ok") throw new Error(`expected outfits, got ${body.reason}`);
  return body;
}

describe("a wardrobe without shoes, then Find in my shops (mock mode off)", () => {
  it("returns outfits with a shoes gap, saves the gaps, and lists shoes as missing", async () => {
    const body = await gapOutfits();
    expect(body.missingCategories).toEqual(["shoes"]);
    for (const o of body.outfits) expect(o.gaps.map((g) => g.category)).toEqual(["shoes"]);
    expect((fake.db.tables.outfits![0]!.gaps as unknown[]).length).toBe(1);
  });

  it("searches, keeps only favourite-shop links, stores three products and counts one search", async () => {
    const [outfit] = (await gapOutfits()).outfits;
    const res = await shopSearch.POST(json(`/api/outfits/${outfit!.id}/shop-search`, "POST"), ctx(outfit!.id));
    expect(res.status).toBe(200);
    const found = OutfitResponseSchema.parse(await res.json()).outfit;
    expect(found.gaps[0]!.shopResults.map((p) => p.shopId)).toEqual(["next", "marks_and_spencer", "new_look"]);
    expect(new Set(fake.checked.map((c) => new URL(c.url).host))).toEqual(new Set(["www.next.co.uk", "www.marksandspencer.com", "www.newlook.com"]));
    const row = fake.db.tables.outfits!.find((r) => r.id === outfit!.id)!;
    expect((row.gaps as { shopResults: unknown[] }[])[0]!.shopResults).toHaveLength(3);
    expect(fake.usage.events.filter((e) => e.kind === "shop_search")).toHaveLength(1);
    expect(fake.usage.events.filter((e) => e.kind === "shop_grounding")).toHaveLength(1);
    expect(geminiCalls).toBe(1);
  });

  it("chooses one of the stored results, refuses a planted link, and clears the pick", async () => {
    const [outfit] = (await gapOutfits()).outfits;
    const found = OutfitResponseSchema.parse(await (await shopSearch.POST(json("/x", "POST"), ctx(outfit!.id))).json()).outfit;
    const product = found.gaps[0]!.shopResults[2]!;
    const chosen = OutfitResponseSchema.parse(await (await gapProduct.PUT(json("/x", "PUT", { productUrl: product.url }), gapCtx(outfit!.id, "shoes"))).json());
    expect(chosen.outfit.gaps[0]!.shopProduct).toEqual(product);
    await expectError(await gapProduct.PUT(json("/x", "PUT", { productUrl: "https://www.next.co.uk/planted" }), gapCtx(outfit!.id, "shoes")), "bad_request");
    await expectError(await gapProduct.PUT(json("/x", "PUT", { productUrl: null }), gapCtx(outfit!.id, "top")), "not_found");
    const cleared = OutfitResponseSchema.parse(await (await gapProduct.PUT(json("/x", "PUT", { productUrl: null }), gapCtx(outfit!.id, "shoes"))).json());
    expect(cleared.outfit.gaps[0]!.shopProduct).toBeNull();
  });

  it("another user's outfit is not_found for both routes, and nothing is counted", async () => {
    const [outfit] = (await gapOutfits()).outfits;
    const before = fake.usage.events.length;
    fake.user = OTHER;
    await expectError(await shopSearch.POST(json("/x", "POST"), ctx(outfit!.id)), "not_found");
    await expectError(await gapProduct.PUT(json("/x", "PUT", { productUrl: null }), gapCtx(outfit!.id, "shoes")), "not_found");
    expect(fake.usage.events.length).toBe(before);
    expect(geminiCalls).toBe(0);
  });

  it("an outfit without gaps is a bad_request, before anything is counted", async () => {
    fake.db.tables.outfits!.push({
      id: "1a000000-0000-4000-8000-0000000000aa",
      user_id: USER.id,
      request: { style: { kind: "preset", presetId: "work" }, guidance: null, anchorItemId: null },
      name: "Complete",
      reason: "All owned",
      item_ids: [NO_SHOES[0]!.id, NO_SHOES[3]!.id],
      gaps: [],
      status: "suggested",
      parent_outfit_id: null,
      created_at: "2026-10-31 10:00:00+00",
    });
    await expectError(await shopSearch.POST(json("/x", "POST"), ctx("1a000000-0000-4000-8000-0000000000aa")), "bad_request");
    expect(fake.usage.events).toEqual([]);
  });

  it("needs a signed-in user", async () => {
    fake.user = null;
    await expectError(await shopSearch.POST(json("/x", "POST"), ctx("1a000000-0000-4000-8000-0000000000aa")), "unauthorized");
  });
});
