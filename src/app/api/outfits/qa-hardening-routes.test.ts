/**
 * QA (fix/hardening): the outfit request cap and the monthly AI cap under
 * parallel requests, through the real route handlers (mock mode OFF), with
 * Supabase faked in memory and the ranking model replaced by recorded
 * replies. Same wiring as outfits-live.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiErrorSchema, OutfitGenerationResponseSchema } from "@/contracts";
import { FakeRankingProvider } from "@/lib/ai/fakes";
import type { RankingProvider } from "@/lib/ai/types";
import { DAILY_CAPS, ESTIMATED_COST_PENCE, InMemoryUsageStore, MONTHLY_AI_SPEND_CAP_PENCE } from "@/lib/usage";
import { FakeSupabase } from "@/test/fake-supabase";
import { finalReplies, shortlistReplies, WARDROBE } from "@/test/fixtures/outfit-engine";
import { COLOUR_RGB, swatchPng } from "@/test/fixtures/swatch-png";
import { toItemRow } from "@/test/outfit-helpers";

const USER = { id: "0c000000-0000-4000-8000-000000000003", email: "tester@example.com" };

const fake = vi.hoisted(() => ({
  db: null as unknown as FakeSupabase,
  user: null as { id: string; email: string } | null,
  ranking: null as unknown as () => RankingProvider,
  usage: null as unknown as InMemoryUsageStore,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => Object.assign(fake.db, { auth: { getUser: async () => ({ data: { user: fake.user } }) } }),
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
  getServerImageProcessor: () => ({ resize: async (image: { data: Uint8Array }) => image }),
}));

import * as outfits from "./route";

const BASE = "http://localhost:3000";
const request = () =>
  new Request(`${BASE}/api/outfits`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ style: { kind: "preset", presetId: "work" }, count: 3 }),
  });

let ranking: FakeRankingProvider;

beforeEach(() => {
  vi.stubEnv("GLADRAGS_MOCK_MODE", "false");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://qa-project.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_qa");
  fake.db = new FakeSupabase();
  fake.user = USER;
  fake.usage = new InMemoryUsageStore();
  ranking = new FakeRankingProvider({ shortlist: [shortlistReplies.valid], final: [finalReplies.valid] });
  fake.ranking = () => ranking;
  for (const item of WARDROBE) {
    const row = toItemRow(item, USER.id);
    fake.db.tables.items!.push(row);
    fake.db.objects.set(`cutouts/${row.cutout_image_key}`, swatchPng(COLOUR_RGB.navy));
  }
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST /api/outfits under a burst", () => {
  it(`${DAILY_CAPS.outfit_request + 10} requests at once: exactly ${DAILY_CAPS.outfit_request} get outfits, the rest 429, and refused ones make no model calls`, async () => {
    const responses = await Promise.all(Array.from({ length: DAILY_CAPS.outfit_request + 10 }, () => outfits.POST(request())));
    const ok = responses.filter((r) => r.status === 200);
    const capped = responses.filter((r) => r.status === 429);
    expect(ok).toHaveLength(DAILY_CAPS.outfit_request);
    expect(capped).toHaveLength(10);
    for (const res of ok) expect(OutfitGenerationResponseSchema.parse(await res.json()).status).toBe("ok");
    for (const res of capped) expect(ApiErrorSchema.parse(await res.json()).error.cap?.kind).toBe("outfit_requests_per_day");
    expect(fake.usage.events.filter((e) => e.kind === "outfit_request")).toHaveLength(DAILY_CAPS.outfit_request);
    expect(ranking.shortlistCalls).toHaveLength(DAILY_CAPS.outfit_request);
    expect(ranking.finalCalls).toHaveLength(DAILY_CAPS.outfit_request);
  });

  it("near the £5 cap, a burst gets ai_paused once the reservations reach it; the month never passes £5 + 0.5p", async () => {
    // 1p of room: the shortlist (0.2p) and final (0.5p) reservations of the first request use 0.7p.
    await fake.usage.record({ userId: null, kind: "tagging", costPence: MONTHLY_AI_SPEND_CAP_PENCE - 1, provider: "gemini" });
    // The fake ranker reports 0p, so make the costs stick at the estimates instead.
    const original = fake.usage.settle.bind(fake.usage);
    fake.usage.settle = (id, _cost, provider) => {
      const event = fake.usage.events.find((e) => e.id === id)!;
      return original(id, ESTIMATED_COST_PENCE[event.kind as keyof typeof ESTIMATED_COST_PENCE], provider);
    };
    const responses = await Promise.all(Array.from({ length: 10 }, () => outfits.POST(request())));
    const statuses = responses.map((r) => r.status);
    expect(statuses.filter((s) => s === 503).length).toBeGreaterThan(0);
    const spent = Math.round(fake.usage.events.reduce((sum, e) => sum + e.costPence * 10_000, 0)) / 10_000;
    expect(spent).toBeGreaterThanOrEqual(MONTHLY_AI_SPEND_CAP_PENCE);
    expect(spent - MONTHLY_AI_SPEND_CAP_PENCE).toBeLessThan(ESTIMATED_COST_PENCE.ranking_final);
  });
});
