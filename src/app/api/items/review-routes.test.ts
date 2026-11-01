/**
 * Milestone 5 ingestion through the real route handlers, mock mode OFF:
 * batch photo add (saved "to review"), the review filter, confirming one
 * item and "Confirm all", and the cut-out and photo routes for existing
 * items. Supabase and Gemini are replaced by in-memory storage and items, a
 * fake tagger with recorded outputs, and a real UsageGuard. Image checks
 * and EXIF stripping are real (sharp).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiErrorSchema,
  BatchAddResponseSchema,
  ItemDraftResponseSchema,
  ItemListResponseSchema,
  ItemResponseSchema,
  MarkItemsReviewedResponseSchema,
  STORAGE_BUCKETS,
  collageImageUrl,
  type WardrobeItem,
} from "@/contracts";
import { tagging } from "@/test/fixtures/model-output";
import { OTHER_USER, TEST_USER, makeTestDeps } from "@/test/ingestion-deps";
import { asFile, cutoutPng, phoneJpeg, readMetadata } from "@/test/images";

const fake = vi.hoisted(() => ({
  user: null as { id: string; email: string } | null,
  deps: null as unknown as ReturnType<typeof import("@/test/ingestion-deps").makeTestDeps>,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: fake.user } }) } }),
}));

vi.mock("@/lib/ingestion/deps", () => ({
  getWardrobeDeps: async () => fake.deps,
  getPhotoIngestionDeps: () => fake.deps,
  getItemImageDeps: async () => fake.deps,
}));

import * as itemCutout from "./[id]/cutout/route";
import * as itemPhotoReplace from "./[id]/photo/route";
import * as itemById from "./[id]/route";
import * as itemPhoto from "./photo/route";
import * as reviewed from "./reviewed/route";
import * as items from "./route";

const BASE = "http://localhost:3000";
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

function json(path: string, method: string, body?: unknown): Request {
  return new Request(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function multipart(path: string, method: string, fields: Record<string, string | File>): Request {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return new Request(`${BASE}${path}`, { method, body: form });
}

async function errorOf(response: Response) {
  return ApiErrorSchema.parse(await response.json()).error;
}

async function batchAdd(): Promise<WardrobeItem> {
  const res = await itemPhoto.POST(
    multipart("/api/items/photo", "POST", { original: asFile(await phoneJpeg({ width: 800, height: 1000 }), "IMG.jpg"), saveForReview: "true" }),
  );
  expect(res.status).toBe(200);
  const body = BatchAddResponseSchema.parse(await res.json());
  if (body.status !== "saved") throw new Error("expected a saved item");
  return body.item;
}

async function list(query = ""): Promise<WardrobeItem[]> {
  const res = await items.GET(new Request(`${BASE}/api/items${query}`));
  expect(res.status).toBe(200);
  return ItemListResponseSchema.parse(await res.json()).items;
}

beforeEach(() => {
  vi.stubEnv("GLADRAGS_MOCK_MODE", "false");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://qa-project.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_qa");
  fake.user = { id: TEST_USER, email: "tester@example.com" };
  fake.deps = makeTestDeps({ taggerOutputs: [JSON.stringify(tagging.valid)] });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("add several photos, then review them", () => {
  it("upload → saved to review → listed → confirm one → confirm the rest", async () => {
    const first = await batchAdd();
    const second = await batchAdd();
    const third = await batchAdd();
    expect(first).toMatchObject({ needsReview: true, cutoutUrl: null, tags: tagging.valid });
    // No cut-out yet: the collage falls back to the original.
    expect(collageImageUrl(first)).toBe(first.originalUrl);

    expect((await list("?needsReview=true")).map((i) => i.id).sort()).toEqual([first.id, second.id, third.id].sort());

    const confirmed = await itemById.PATCH(json(`/api/items/${first.id}`, "PATCH", { reviewed: true }), ctx(first.id));
    expect(confirmed.status).toBe(200);
    expect(ItemResponseSchema.parse(await confirmed.json()).item).toMatchObject({ needsReview: false, tagsEdited: false });

    const all = await reviewed.POST(json("/api/items/reviewed", "POST", { itemIds: [second.id, third.id, "1a000000-0000-4000-8000-0000000009ff"] }));
    expect(MarkItemsReviewedResponseSchema.parse(await all.json())).toEqual({ updated: 2 });
    expect(await list("?needsReview=true")).toEqual([]);
    expect(await list("?needsReview=false")).toHaveLength(3);
  });

  it("returns the draft when tagging fails twice", async () => {
    fake.deps = makeTestDeps({ taggerOutputs: ["nope", "still nope"] });
    const res = await itemPhoto.POST(multipart("/api/items/photo", "POST", { original: asFile(await phoneJpeg(), "a.jpg"), saveForReview: "true" }));
    const body = BatchAddResponseSchema.parse(await res.json());
    expect(body).toMatchObject({ status: "draft", draft: { suggestedTags: null } });
    expect(await list()).toEqual([]);
  });

  it("a single add (no saveForReview) still returns a draft and saves nothing", async () => {
    const res = await itemPhoto.POST(multipart("/api/items/photo", "POST", { original: asFile(await phoneJpeg(), "a.jpg") }));
    expect(ItemDraftResponseSchema.parse(await res.json()).draft).toMatchObject({ cutoutImageKey: null, suggestedTags: tagging.valid });
    expect(await list()).toEqual([]);
  });

  it("a fourth photo past the daily cap gets 429 and isn't stored", async () => {
    for (let i = 0; i < 3; i++) await batchAdd();
    const res = await itemPhoto.POST(multipart("/api/items/photo", "POST", { original: asFile(await phoneJpeg(), "a.jpg"), saveForReview: "true" }));
    expect(res.status).toBe(429);
    expect((await errorOf(res)).code).toBe("daily_cap_reached");
    expect(fake.deps.storage.objects.size).toBe(3);
  });
});

describe("PUT /api/items/:id/cutout", () => {
  it("stores the collage's cut-out and returns the item with it", async () => {
    const item = await batchAdd();
    const res = await itemCutout.PUT(multipart(`/api/items/${item.id}/cutout`, "PUT", { cutout: asFile(await cutoutPng(), "c.png") }), ctx(item.id));
    expect(res.status).toBe(200);
    const updated = ItemResponseSchema.parse(await res.json()).item;
    expect(updated.cutoutUrl).not.toBeNull();
    expect(collageImageUrl(updated)).toBe(updated.cutoutUrl);
    // Saving a cut-out doesn't count against anything and doesn't touch the review mark.
    expect(updated.needsReview).toBe(true);
    expect(fake.deps.usageStore.events.filter((e) => e.kind === "item_ingest")).toHaveLength(1);
  });

  it("refuses a JPEG, a missing file, and someone else's item", async () => {
    const item = await batchAdd();
    const jpegRes = await itemCutout.PUT(multipart(`/api/items/${item.id}/cutout`, "PUT", { cutout: asFile(await phoneJpeg(), "c.jpg") }), ctx(item.id));
    expect((await errorOf(jpegRes)).code).toBe("bad_request");
    const missing = await itemCutout.PUT(multipart(`/api/items/${item.id}/cutout`, "PUT", {}), ctx(item.id));
    expect((await errorOf(missing)).code).toBe("bad_request");

    fake.user = { id: OTHER_USER, email: "other@example.com" };
    const others = await itemCutout.PUT(multipart(`/api/items/${item.id}/cutout`, "PUT", { cutout: asFile(await cutoutPng(), "c.png") }), ctx(item.id));
    expect(others.status).toBe(404);
  });
});

describe("PUT /api/items/:id/photo", () => {
  it("replaces the picture without EXIF, marks the item to review and keeps the tags", async () => {
    const item = await batchAdd();
    await itemById.PATCH(json(`/api/items/${item.id}`, "PATCH", { reviewed: true }), ctx(item.id));
    const before = (await fake.deps.items.get(TEST_USER, item.id))!;

    const res = await itemPhotoReplace.PUT(
      multipart(`/api/items/${item.id}/photo`, "PUT", { original: asFile(await phoneJpeg({ width: 1000, height: 800, orientation: 6 }), "new.jpg") }),
      ctx(item.id),
    );
    expect(res.status).toBe(200);
    const updated = ItemResponseSchema.parse(await res.json()).item;
    expect(updated).toMatchObject({ needsPhoto: false, needsReview: true, tags: tagging.valid, cutoutUrl: null });

    const after = (await fake.deps.items.get(TEST_USER, item.id))!;
    expect(after.original_image_key).not.toBe(before.original_image_key);
    expect(await fake.deps.storage.exists(STORAGE_BUCKETS.originals, before.original_image_key)).toBe(false);
    const meta = await readMetadata(fake.deps.storage.get(STORAGE_BUCKETS.originals, after.original_image_key)!);
    expect(meta).toMatchObject({ exif: undefined, mentionsCamera: false });
    // No re-tagging.
    expect(fake.deps.fakeTagger.calls).toHaveLength(1);
  });

  it("refuses a GIF", async () => {
    const item = await batchAdd();
    const res = await itemPhotoReplace.PUT(multipart(`/api/items/${item.id}/photo`, "PUT", { original: new File(["GIF89a"], "a.gif") }), ctx(item.id));
    expect((await errorOf(res)).code).toBe("bad_request");
  });
});
