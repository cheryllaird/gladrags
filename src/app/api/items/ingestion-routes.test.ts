/**
 * The add-by-photo journey through the real route handlers, mock mode OFF:
 * upload (original + cut-out) → draft with tags → save → list, search,
 * edit, delete. Supabase and Gemini are replaced by in-memory storage and
 * items, a fake tagger with recorded outputs, and a real UsageGuard. Image
 * checks and EXIF stripping are real (sharp).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiErrorSchema,
  ItemDraftResponseSchema,
  ItemListResponseSchema,
  ItemResponseSchema,
  STORAGE_BUCKETS,
  type ItemDraft,
} from "@/contracts";
import { tagging } from "@/test/fixtures/model-output";
import { TEST_USER, makeTestDeps } from "@/test/ingestion-deps";
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
}));

import * as itemById from "./[id]/route";
import * as itemPhoto from "./photo/route";
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

async function photoRequest(options: { cutout?: boolean } = {}): Promise<Request> {
  const form = new FormData();
  form.set("original", asFile(await phoneJpeg({ width: 1200, height: 1600 }), "IMG_0001.jpg"));
  if (options.cutout !== false) form.set("cutout", asFile(await cutoutPng(), "cutout.png"));
  return new Request(`${BASE}/api/items/photo`, { method: "POST", body: form });
}

async function errorOf(response: Response) {
  return ApiErrorSchema.parse(await response.json()).error;
}

async function uploadDraft(options: { cutout?: boolean } = {}): Promise<ItemDraft> {
  const res = await itemPhoto.POST(await photoRequest(options));
  expect(res.status).toBe(200);
  return ItemDraftResponseSchema.parse(await res.json()).draft;
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

describe("add by photo, end to end (mocked providers)", () => {
  it("upload → cut-out → tags → saved item → listed, searched, edited, deleted", async () => {
    // Upload: the draft carries the stored images and the suggested tags.
    const draft = await uploadDraft();
    expect(draft.suggestedTags).toEqual(tagging.valid);
    expect(draft.cutoutImageKey).not.toBeNull();
    const stored = fake.deps.storage.get(STORAGE_BUCKETS.originals, draft.originalImageKey)!;
    expect(await readMetadata(stored)).toMatchObject({ exif: undefined, mentionsCamera: false });

    // Save, as the tag review form does.
    const saveRes = await items.POST(
      json("/api/items", "POST", {
        source: draft.source,
        sourceUrl: draft.sourceUrl,
        originalImageKey: draft.originalImageKey,
        cutoutImageKey: draft.cutoutImageKey,
        tags: draft.suggestedTags,
        tagsEdited: false,
      }),
    );
    expect(saveRes.status).toBe(201);
    const { item } = ItemResponseSchema.parse(await saveRes.json());
    expect(item).toMatchObject({ tags: tagging.valid, tagsEdited: false });

    // List and search.
    const list = ItemListResponseSchema.parse(await (await items.GET(json("/api/items?category=bottom&q=chinos", "GET"))).json());
    expect(list.items.map((i) => i.id)).toEqual([item.id]);
    const none = ItemListResponseSchema.parse(await (await items.GET(json("/api/items?category=shoes", "GET"))).json());
    expect(none.items).toEqual([]);

    // Read, edit, delete.
    const got = ItemResponseSchema.parse(await (await itemById.GET(json(`/api/items/${item.id}`, "GET"), ctx(item.id))).json());
    expect(got.item.id).toBe(item.id);
    const edited = await itemById.PATCH(
      json(`/api/items/${item.id}`, "PATCH", { tags: { ...tagging.valid, colours: ["olive"] } }),
      ctx(item.id),
    );
    expect(ItemResponseSchema.parse(await edited.json()).item).toMatchObject({ tagsEdited: true, tags: { colours: ["olive"] } });
    const deleted = await itemById.DELETE(json(`/api/items/${item.id}`, "DELETE"), ctx(item.id));
    expect(await deleted.json()).toEqual({ deleted: true });
    expect(await fake.deps.storage.exists(STORAGE_BUCKETS.originals, draft.originalImageKey)).toBe(false);
    expect(await fake.deps.storage.exists(STORAGE_BUCKETS.cutouts, draft.cutoutImageKey!)).toBe(false);
    expect((await itemById.GET(json(`/api/items/${item.id}`, "GET"), ctx(item.id))).status).toBe(404);
  });

  it("a draft whose tagging failed twice comes back with null tags, and saves with the user's tags", async () => {
    fake.deps = makeTestDeps({ taggerOutputs: [tagging.inventedColour, tagging.multiLineDescription] });
    const draft = await uploadDraft({ cutout: false });
    expect(draft).toMatchObject({ suggestedTags: null, cutoutImageKey: null, cutoutUrl: null });
    const save = await items.POST(
      json("/api/items", "POST", { ...draft, tags: tagging.valid, tagsEdited: true, suggestedTags: undefined }),
    );
    expect(save.status).toBe(201);
  });
});

describe("caps through the route", () => {
  it("answers 429 daily_cap_reached once today's items are used up", async () => {
    for (let i = 0; i < 3; i++) await uploadDraft({ cutout: false });
    const res = await itemPhoto.POST(await photoRequest());
    expect(res.status).toBe(429);
    const error = await errorOf(res);
    expect(error.code).toBe("daily_cap_reached");
    expect(error.cap?.kind).toBe("items_per_day");
  });

  it("answers 503 ai_paused when the monthly spend cap is reached, and stores nothing", async () => {
    await fake.deps.usage.recordAiCost(null, "tagging", 5, "gemini");
    const res = await itemPhoto.POST(await photoRequest());
    expect(res.status).toBe(503);
    expect((await errorOf(res)).code).toBe("ai_paused");
    expect(fake.deps.storage.objects.size).toBe(0);
    // Browsing still works while AI is paused.
    expect((await items.GET(json("/api/items", "GET"))).status).toBe(200);
  });
});

describe("validation through the route", () => {
  it("answers 400 naming the field for an image that's too big", async () => {
    const form = new FormData();
    form.set("original", asFile(await phoneJpeg({ width: 2000, height: 1000 }), "big.jpg"));
    const res = await itemPhoto.POST(new Request(`${BASE}/api/items/photo`, { method: "POST", body: form }));
    expect(res.status).toBe(400);
    expect((await errorOf(res)).issues).toEqual([{ path: "original", message: "Must be at most 1600 px on its longest side" }]);
  });

  it("answers 401 when signed out, before reading the upload", async () => {
    fake.user = null;
    const res = await itemPhoto.POST(await photoRequest());
    expect(res.status).toBe(401);
    expect(fake.deps.storage.objects.size).toBe(0);
  });
});
