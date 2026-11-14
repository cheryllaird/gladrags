/**
 * POST /api/outfits/[id]/preview with mock mode OFF: fake Supabase (with a
 * JavaScript copy of the claim and finish functions), a fake image model
 * with recorded replies, fake storage and in-memory usage. No network.
 */
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  API_ERROR_STATUS,
  ApiErrorSchema,
  PreviewResponseSchema,
  previewCacheKey,
  type ApiErrorCode,
  type GapDescription,
  type ShopProduct,
} from "@/contracts";
import { FakeImageGenerationProvider, type FakeImageReply } from "@/lib/ai/fakes";
import {
  PREVIEW_REPLY_BLOCKED,
  PREVIEW_REPLY_EMPTY,
  PREVIEW_REPLY_GOOD,
  PREVIEW_REPLY_NOT_AN_IMAGE,
  PREVIEW_REPLY_SQUARE,
} from "@/lib/ai/fixtures/preview-fixtures";
import type { ImageGenerationProvider } from "@/lib/ai/types";
import { SafeFetchError, type SafeFetchOptions } from "@/lib/link-import/safe-fetch";
import { InMemoryUsageStore } from "@/lib/usage";
import { FakePreviewSupabase } from "@/test/fake-previews";
import { entry, toItemRow, uuid } from "@/test/outfit-helpers";

const USER = { id: "0c000000-0000-4000-8000-000000000003", email: "tester@example.com" };
const OTHER = { id: "0c000000-0000-4000-8000-000000000004", email: "other@example.com" };
const PRESET = "women_average_medium";

const fake = vi.hoisted(() => ({
  db: null as unknown as FakePreviewSupabase,
  user: null as { id: string; email: string } | null,
  provider: null as unknown as ImageGenerationProvider,
  usage: null as unknown as InMemoryUsageStore,
  fetches: [] as { url: string; options: SafeFetchOptions }[],
  fetchReply: null as null | ((url: string) => Promise<{ finalUrl: URL; contentType: string | null; body: Uint8Array }>),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => Object.assign(fake.db, { auth: { getUser: async () => ({ data: { user: fake.user } }) } }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => fake.db }));
vi.mock("@/lib/ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai")>()),
  getImageGenerationProvider: () => fake.provider,
}));
vi.mock("@/lib/usage", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/usage")>();
  return { ...original, getUsageGuard: () => new original.UsageGuard(fake.usage) };
});
vi.mock("@/lib/images/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/images/server")>()),
  getServerImageProcessor: () => ({
    inspect: async () => ({ width: 600, height: 800, mimeType: "image/jpeg", bytes: 3, hasAlpha: false }),
    prepareForModel: async (image: { data: Uint8Array }) => ({ data: image.data, mimeType: "image/jpeg" }),
  }),
}));
vi.mock("@/lib/link-import/safe-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/link-import/safe-fetch")>()),
  safeFetch: async (url: string, options: SafeFetchOptions) => {
    fake.fetches.push({ url, options });
    if (!fake.fetchReply) throw new Error("No network in tests");
    return fake.fetchReply(url);
  },
}));

import { POST } from "./route";

const REQUEST = { style: { kind: "preset", presetId: "work" }, guidance: null, anchorItemId: null, includeShopItems: false };
const SHOES_GAP: GapDescription = { category: "shoes", subcategory: "trainers", colours: ["white"], description: "White leather trainers" };
const PRODUCT: ShopProduct = {
  shopId: "next",
  title: "White leather trainers",
  url: "https://www.next.co.uk/style/st123",
  priceText: "£30",
  imageUrl: "https://www.next.co.uk/images/trainers.jpg",
};
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

function post(id: string, refresh = false) {
  const url = `http://localhost:3000/api/outfits/${id}/preview${refresh ? "?refresh=true" : ""}`;
  return POST(new Request(url, { method: "POST" }), { params: Promise.resolve({ id }) });
}

async function ok(response: Response) {
  expect(response.status).toBe(200);
  return PreviewResponseSchema.parse(await response.json()).outfit;
}

async function expectError(response: Response, code: ApiErrorCode) {
  expect(response.status).toBe(API_ERROR_STATUS[code]);
  const body = ApiErrorSchema.parse(await response.json());
  expect(body.error.code).toBe(code);
  return body.error;
}

let nextOutfit = 0;
function addOutfit(opts: { itemIds?: string[]; gaps?: unknown[]; userId?: string } = {}): string {
  const id = uuid(700 + nextOutfit++);
  fake.db.outfits.push({
    id,
    user_id: opts.userId ?? USER.id,
    request: REQUEST,
    name: "Look",
    reason: "Works",
    item_ids: opts.itemIds ?? [uuid(1), uuid(2), uuid(3)],
    gaps: opts.gaps ?? [],
    status: "suggested",
    parent_outfit_id: null,
    created_at: fake.db.nextTimestamp(),
    preview_id: null,
    pending_preview_id: null,
    preview_outdated: false,
  });
  return id;
}

const gapWith = (shopProduct: ShopProduct | null) => ({ ...SHOES_GAP, shopResults: shopProduct ? [shopProduct] : [], searchedAt: null, shopProduct });
const outfitRow = (id: string) => fake.db.outfits.find((o) => o.id === id)!;
const previewRow = (id: unknown) => fake.db.previews.find((p) => p.id === id)!;
const events = (kind: string) => fake.usage.events.filter((e) => e.kind === kind);
const fakeProvider = () => fake.provider as FakeImageGenerationProvider;

function useReplies(...replies: FakeImageReply[]) {
  fake.provider = new FakeImageGenerationProvider(replies);
}

function addPreview(patch: Record<string, unknown>) {
  const row = {
    id: crypto.randomUUID(),
    user_id: USER.id,
    cache_key: "f".repeat(64),
    preset_id: PRESET,
    item_ids: [uuid(1), uuid(2), uuid(3)],
    suggested_slots: [],
    status: "ready",
    image_key: `${USER.id}/${crypto.randomUUID()}.webp`,
    failure_reason: null,
    attempted_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...patch,
  };
  fake.db.previews.push(row);
  return row;
}

beforeEach(() => {
  vi.stubEnv("GLADRAGS_MOCK_MODE", "false");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://qa-project.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_qa");
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  fake.db = new FakePreviewSupabase();
  fake.user = USER;
  fake.usage = new InMemoryUsageStore();
  fake.fetches = [];
  fake.fetchReply = null;
  useReplies(PREVIEW_REPLY_GOOD);
  fake.db.tables.items!.push(
    toItemRow(entry(1, "top", { description: "White linen shirt" }), USER.id),
    toItemRow(entry(2, "bottom", { description: "Navy chinos" }), USER.id),
    toItemRow(entry(3, "shoes", { description: "Brown loafers" }), USER.id),
  );
  for (const row of fake.db.tables.items!) fake.db.objects.set(`cutouts/${row.cutout_image_key as string}`, JPEG_BYTES);
  fake.db.tables.user_settings!.push({ user_id: USER.id, model_preset_id: PRESET });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST /api/outfits/[id]/preview: generating", () => {
  it("generates, stores an exactly-2:3 WebP in previews, finishes ready and returns a signed URL", async () => {
    const id = addOutfit();
    const outfit = await ok(await post(id));
    expect(outfit.preview).toMatchObject({ status: "ready", failureReason: null, presetId: PRESET, suggestedSlots: [], outdated: false, refreshing: false });
    const [upload] = fake.db.uploads;
    expect(upload).toMatchObject({ bucket: "previews", mimeType: "image/webp" });
    expect(upload!.key).toMatch(new RegExp(`^${USER.id}/[0-9a-f-]{36}\\.webp$`));
    expect(outfit.preview.imageUrl).toBe(`https://signed.test/previews/${upload!.key}?ttl=3600`);
    const meta = await sharp(fake.db.objects.get(`previews/${upload!.key}`)!).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.width! * 3).toBe(meta.height! * 2);
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(1536);
    expect(previewRow(outfitRow(id).preview_id)).toMatchObject({ status: "ready", image_key: upload!.key });
    // Counted once, and the real reported cost recorded.
    expect(events("outfit_preview")).toHaveLength(1);
    expect(events("image_generation").map((e) => e.costPence)).toEqual([3.1]);
  });

  it("sends the preset figure, each item's cut-out and description to the model", async () => {
    await ok(await post(addOutfit()));
    const [input] = fakeProvider().calls;
    expect(input!.preset).toMatchObject({ id: PRESET, label: "Women's, average build, medium skin tone" });
    expect(input!.preset.image.mimeType).toBe("image/webp");
    expect(input!.items.map((i) => [i.category, i.description, i.image !== null])).toEqual([
      ["top", "White linen shirt", true],
      ["bottom", "Navy chinos", true],
      ["shoes", "Brown loafers", true],
    ]);
    expect(input!.aspectRatio).toEqual({ width: 2, height: 3 });
  });

  it("describes a needsPhoto item in words and sends no picture for it", async () => {
    Object.assign(fake.db.tables.items![1]!, { needs_photo: true });
    await ok(await post(addOutfit()));
    const item = fakeProvider().calls[0]!.items[1]!;
    expect(item.image).toBeNull();
    expect(item.description).toMatch(/^navy plain chinos\. Navy chinos$/);
  });

  it("describes a gap in words, and labels its slot as suggested", async () => {
    const id = addOutfit({ itemIds: [uuid(1), uuid(2)], gaps: [gapWith(null)] });
    const outfit = await ok(await post(id));
    expect(outfit.preview.suggestedSlots).toEqual(["shoes"]);
    expect(fakeProvider().calls[0]!.gaps).toEqual([{ ...SHOES_GAP, productImage: null }]);
    expect(fake.fetches).toHaveLength(0);
  });

  it("sends a picked product's picture, fetched with redirects held to the shop's own hosts", async () => {
    fake.fetchReply = async (url) => ({ finalUrl: new URL(url), contentType: "image/jpeg", body: JPEG_BYTES });
    await ok(await post(addOutfit({ itemIds: [uuid(1), uuid(2)], gaps: [gapWith(PRODUCT)] })));
    expect(fake.fetches.map((f) => f.url)).toEqual([PRODUCT.imageUrl]);
    const { allowRedirect } = fake.fetches[0]!.options;
    expect(allowRedirect!(new URL("https://cdn.next.co.uk/x.jpg"))).toBe(true);
    expect(allowRedirect!(new URL("https://evil.example/x.jpg"))).toBe(false);
    expect(allowRedirect!(new URL("http://www.next.co.uk/x.jpg"))).toBe(false);
    expect(fakeProvider().calls[0]!.gaps[0]!.productImage).toEqual({ data: JPEG_BYTES, mimeType: "image/jpeg" });
  });

  it("falls back to words when the product picture is refused (off-shop host, a refused redirect, not an image)", async () => {
    // Off the shop's hosts: never fetched.
    await ok(await post(addOutfit({ itemIds: [uuid(1), uuid(2)], gaps: [gapWith({ ...PRODUCT, imageUrl: "https://images.evil.example/t.jpg" })] })));
    expect(fake.fetches).toHaveLength(0);
    expect(fakeProvider().calls[0]!.gaps[0]).toMatchObject({ description: SHOES_GAP.description, productImage: null });

    // A redirect off the shop: safeFetch refuses it.
    fake.fetchReply = async () => Promise.reject(new SafeFetchError("redirect_refused", "no"));
    await ok(await post(addOutfit({ itemIds: [uuid(1), uuid(3)], gaps: [gapWith(PRODUCT)] })));
    expect(fakeProvider().calls[1]!.gaps[0]!.productImage).toBeNull();

    // Fetched, but not an image.
    fake.fetchReply = async (url) => ({ finalUrl: new URL(url), contentType: "image/jpeg", body: new TextEncoder().encode("<html>") });
    await ok(await post(addOutfit({ itemIds: [uuid(2), uuid(3)], gaps: [gapWith(PRODUCT)] })));
    expect(fakeProvider().calls[2]!.gaps[0]!.productImage).toBeNull();
  });
});

describe("POST /api/outfits/[id]/preview: no new picture needed", () => {
  it("answers bad_request with path modelPresetId when no preset is picked, changing nothing", async () => {
    fake.db.tables.user_settings![0]!.model_preset_id = null;
    const error = await expectError(await post(addOutfit()), "bad_request");
    expect(error.issues?.[0]?.path).toBe("modelPresetId");
    expect(fake.db.rpcCalls).toHaveLength(0);
  });

  it("answers not_found for another user's outfit", async () => {
    await expectError(await post(addOutfit({ userId: OTHER.id })), "not_found");
    expect(fake.db.rpcCalls).toHaveLength(0);
  });

  it("existing: a second POST for the same outfit makes nothing new", async () => {
    const id = addOutfit();
    await ok(await post(id));
    const again = await ok(await post(id));
    expect(again.preview.status).toBe("ready");
    expect(fakeProvider().calls).toHaveLength(1);
    expect(events("outfit_preview")).toHaveLength(1);
  });

  it("reused: another outfit with the same look shares the stored picture at no cost", async () => {
    const first = await ok(await post(addOutfit()));
    const second = await ok(await post(addOutfit({ itemIds: [uuid(3), uuid(1), uuid(2)] })));
    expect(second.preview.imageUrl).toBe(first.preview.imageUrl);
    expect(fakeProvider().calls).toHaveLength(1);
    expect(events("outfit_preview")).toHaveLength(1);
    expect(events("image_generation")).toHaveLength(1);
  });

  it("wait: a look being made by another request shows as pending", async () => {
    const id = addOutfit();
    const cacheKey = await previewCacheKey({ presetId: PRESET, itemIds: [uuid(1), uuid(2), uuid(3)], gaps: [] });
    addPreview({ cache_key: cacheKey, status: "pending", image_key: null });
    const outfit = await ok(await post(id));
    expect(outfit.preview.status).toBe("pending");
    expect(fakeProvider().calls).toHaveLength(0);
    expect(events("outfit_preview")).toHaveLength(0);
  });
});

describe("POST /api/outfits/[id]/preview?refresh=true", () => {
  async function outdatedOutfit() {
    const id = addOutfit({ itemIds: [uuid(1), uuid(2)], gaps: [gapWith(null)] });
    const before = await ok(await post(id));
    const oldKey = previewRow(outfitRow(id).preview_id).image_key as string;
    // The user picks a product: the database marks the picture outdated.
    Object.assign(outfitRow(id), { gaps: [gapWith(PRODUCT)], preview_outdated: true });
    return { id, before, oldKey };
  }

  it("keeps showing the old picture while the new one is made, then switches and removes the old image", async () => {
    const { id, before, oldKey } = await outdatedOutfit();
    fake.fetchReply = async (url) => ({ finalUrl: new URL(url), contentType: "image/jpeg", body: JPEG_BYTES });
    const seen: unknown[] = [];
    const inner = new FakeImageGenerationProvider([PREVIEW_REPLY_GOOD]);
    fake.provider = {
      name: "fake",
      generatePreview: async (input) => {
        const row = outfitRow(id);
        seen.push({ shows: previewRow(row.preview_id).image_key, pending: row.pending_preview_id !== null });
        return inner.generatePreview(input);
      },
    };
    const after = await ok(await post(id, true));
    expect(seen).toEqual([{ shows: oldKey, pending: true }]);
    expect(after.preview).toMatchObject({ status: "ready", outdated: false, refreshing: false });
    expect(after.preview.imageUrl).not.toBe(before.preview.imageUrl);
    expect(fake.db.removed.flatMap((r) => r.keys)).toContain(oldKey);
    expect(events("outfit_preview")).toHaveLength(2);
  });

  it("a failed refresh keeps the old, still outdated picture", async () => {
    const { id, before } = await outdatedOutfit();
    useReplies("throw");
    await expectError(await post(id, true), "ai_failed");
    const row = outfitRow(id);
    expect(row.pending_preview_id).toBeNull();
    expect(row.preview_outdated).toBe(true);
    const { preview } = await ok(await post(id)); // not a refresh: what it shows stands
    expect(preview).toMatchObject({ status: "ready", outdated: true, refreshing: false, imageUrl: before.preview.imageUrl });
  });

  it("a capped refresh changes nothing: no claim, the outdated picture stays", async () => {
    const { id } = await outdatedOutfit();
    for (let i = 0; i < 12; i++) await fake.usage.record({ userId: USER.id, kind: "outfit_preview", costPence: 0, provider: null });
    const claimsBefore = fake.db.rpcCalls.length;
    const error = await expectError(await post(id, true), "daily_cap_reached");
    expect(error.cap?.kind).toBe("outfit_previews_per_day");
    expect(fake.db.rpcCalls).toHaveLength(claimsBefore);
    expect(outfitRow(id)).toMatchObject({ preview_outdated: true, pending_preview_id: null });
  });

  it("polling a refresh in progress isn't refused by the cap", async () => {
    const { id } = await outdatedOutfit();
    const cacheKey = await previewCacheKey({ presetId: PRESET, itemIds: [uuid(1), uuid(2)], gaps: [gapWith(PRODUCT)] });
    const pending = addPreview({ cache_key: cacheKey, status: "pending", image_key: null, item_ids: [uuid(1), uuid(2)] });
    outfitRow(id).pending_preview_id = pending.id;
    for (let i = 0; i < 12; i++) await fake.usage.record({ userId: USER.id, kind: "outfit_preview", costPence: 0, provider: null });
    const outfit = await ok(await post(id, true));
    expect(outfit.preview).toMatchObject({ status: "ready", outdated: true, refreshing: true });
    expect(fakeProvider().calls).toHaveLength(1); // only the first, original picture
  });

  it("unavailable: a refresh onto a look that failed for good keeps the old picture", async () => {
    const { id, before } = await outdatedOutfit();
    const cacheKey = await previewCacheKey({ presetId: PRESET, itemIds: [uuid(1), uuid(2)], gaps: [gapWith(PRODUCT)] });
    addPreview({ cache_key: cacheKey, status: "failed", image_key: null, failure_reason: "blocked", item_ids: [uuid(1), uuid(2)] });
    const outfit = await ok(await post(id, true));
    expect(outfit.preview).toMatchObject({ status: "ready", outdated: true, refreshing: false, imageUrl: before.preview.imageUrl });
    expect(fakeProvider().calls).toHaveLength(1);
  });
});

describe("POST /api/outfits/[id]/preview: caps, pauses and bad replies", () => {
  it("retries the claim and the finish once on a deadlock (40P01)", async () => {
    fake.db.rpcErrors.set("claim_outfit_preview", [{ message: "deadlock detected", code: "40P01" }]);
    fake.db.rpcErrors.set("finish_outfit_preview", [{ message: "deadlock detected", code: "40P01" }]);
    const outfit = await ok(await post(addOutfit()));
    expect(outfit.preview.status).toBe("ready");
    expect(fake.db.rpcCalls.map((c) => c.fn)).toEqual(["claim_outfit_preview", "claim_outfit_preview", "finish_outfit_preview", "finish_outfit_preview"]);
  });

  it("doesn't retry other database errors", async () => {
    fake.db.rpcErrors.set("claim_outfit_preview", [{ message: "boom", code: "XX000" }]);
    await expectError(await post(addOutfit()), "internal");
    expect(fake.db.rpcCalls).toHaveLength(1);
  });

  it("at the daily cap: finishes the look as skipped (daily_cap_reached) without calling the model", async () => {
    for (let i = 0; i < 12; i++) await fake.usage.record({ userId: USER.id, kind: "outfit_preview", costPence: 0, provider: null });
    const id = addOutfit();
    const error = await expectError(await post(id), "daily_cap_reached");
    expect(error.cap?.kind).toBe("outfit_previews_per_day");
    expect(previewRow(outfitRow(id).preview_id)).toMatchObject({ status: "skipped", failure_reason: "daily_cap_reached" });
    expect(fakeProvider().calls).toHaveLength(0);
  });

  it("with the images share spent: finishes as skipped (ai_paused), counts nothing, keeps the collage", async () => {
    await fake.usage.record({ userId: OTHER.id, kind: "image_generation", costPence: 200, provider: "gemini" });
    const id = addOutfit();
    const error = await expectError(await post(id), "ai_paused");
    expect(error.cap?.kind).toBe("monthly_image_spend");
    expect(previewRow(outfitRow(id).preview_id)).toMatchObject({ status: "skipped", failure_reason: "ai_paused" });
    expect(events("outfit_preview")).toHaveLength(0);
    expect(fakeProvider().calls).toHaveLength(0);
    // A later POST tries again (skipped never stands).
    fake.usage.events.length = 0;
    expect((await ok(await post(id))).preview.status).toBe("ready");
  });

  it("blocked twice: failed (blocked), 502 ai_failed, the collage stays", async () => {
    useReplies(PREVIEW_REPLY_BLOCKED);
    const id = addOutfit();
    await expectError(await post(id), "ai_failed");
    expect(fakeProvider().calls).toHaveLength(2);
    expect(previewRow(outfitRow(id).preview_id)).toMatchObject({ status: "failed", failure_reason: "blocked", image_key: null });
    expect(fake.db.uploads).toHaveLength(0);
    expect(events("image_generation")).toHaveLength(2);
    // Final for this look: no new attempt.
    expect((await ok(await post(id))).preview).toMatchObject({ status: "failed", failureReason: "blocked" });
    expect(fakeProvider().calls).toHaveLength(2);
  });

  it("an invalid image is retried once; two invalid ones fail as invalid_image", async () => {
    useReplies(PREVIEW_REPLY_SQUARE, PREVIEW_REPLY_GOOD);
    expect((await ok(await post(addOutfit()))).preview.status).toBe("ready");
    expect(fakeProvider().calls).toHaveLength(2);

    useReplies(PREVIEW_REPLY_SQUARE, PREVIEW_REPLY_NOT_AN_IMAGE);
    const id = addOutfit({ itemIds: [uuid(1), uuid(2)] });
    await expectError(await post(id), "ai_failed");
    expect(previewRow(outfitRow(id).preview_id)).toMatchObject({ status: "failed", failure_reason: "invalid_image" });
  });

  it("no image, or a provider error, twice: failed (ai_failed)", async () => {
    useReplies(PREVIEW_REPLY_EMPTY, "throw");
    const id = addOutfit();
    await expectError(await post(id), "ai_failed");
    expect(previewRow(outfitRow(id).preview_id)).toMatchObject({ status: "failed", failure_reason: "ai_failed" });
    // A thrown attempt keeps its estimate (it may still be billed).
    expect(events("image_generation").map((e) => e.costPence)).toEqual([0, 4]);
  });

  it("records the estimate for a NaN or negative reported cost", async () => {
    const good = PREVIEW_REPLY_GOOD as { image: { data: Uint8Array; mimeType: string } };
    useReplies({ image: good.image, costPence: Number.NaN });
    await ok(await post(addOutfit()));
    useReplies({ image: good.image, costPence: -3 });
    await ok(await post(addOutfit({ itemIds: [uuid(1), uuid(2)] })));
    expect(events("image_generation").map((e) => e.costPence)).toEqual([4, 4]);
  });

  it("removes the stored image when finish says the look has gone (an item was deleted meanwhile)", async () => {
    const id = addOutfit();
    fake.provider = {
      name: "fake",
      generatePreview: async (input) => {
        fake.db.previews.length = 0; // the items trigger deleted the row
        return new FakeImageGenerationProvider([PREVIEW_REPLY_GOOD]).generatePreview(input);
      },
    };
    await post(id);
    const [upload] = fake.db.uploads;
    expect(fake.db.removed.flatMap((r) => r.keys)).toContain(upload!.key);
    expect(fake.db.objects.has(`previews/${upload!.key}`)).toBe(false);
  });

  it("a storage failure fails the look as internal (the paid call keeps its count)", async () => {
    const from = fake.db.storage.from;
    (fake.db.storage as { from: unknown }).from = (bucket: string) => ({
      ...from(bucket),
      upload: async () => ({ data: null, error: { message: "storage down" } }),
    });
    const id = addOutfit();
    await expectError(await post(id), "internal");
    expect(previewRow(outfitRow(id).preview_id)).toMatchObject({ status: "failed", failure_reason: "internal" });
    expect(events("outfit_preview")).toHaveLength(1);
  });

  it("an error before any model call fails the look as internal and gives the count back", async () => {
    fake.provider = undefined as unknown as ImageGenerationProvider; // e.g. the key isn't configured
    const id = addOutfit();
    await expectError(await post(id), "internal");
    expect(previewRow(outfitRow(id).preview_id)).toMatchObject({ status: "failed", failure_reason: "internal" });
    expect(events("outfit_preview")).toHaveLength(0);
    expect(events("image_generation")).toHaveLength(0);
  });
});
