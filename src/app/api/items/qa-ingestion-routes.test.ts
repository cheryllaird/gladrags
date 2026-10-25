/**
 * QA gap tests through the real route handlers, mock mode OFF (as in
 * ingestion-routes.test.ts): hostile and mislabelled uploads, the status
 * codes users see, and the items CRUD rules (CONTRACTS.md section 5).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiErrorSchema,
  ItemDraftResponseSchema,
  ItemResponseSchema,
  STORAGE_BUCKETS,
  type CreateItemRequest,
  type ItemDraft,
  type ItemTags,
} from "@/contracts";
import { newImageKey } from "@/lib/ingestion/storage";
import { tagging } from "@/test/fixtures/model-output";
import { cutoutPng, phoneJpeg } from "@/test/images";
import { OTHER_USER, TEST_USER, makeTestDeps } from "@/test/ingestion-deps";
import { GIF_BYTES, HOSTILE_SVG, pngBomb, truncated, webpWithExifAndXmp } from "@/test/qa-hostile-images";

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
const TAGS = tagging.valid as ItemTags;

function file(bytes: Uint8Array | Buffer, name: string, type: string): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

function photoForm(fields: Record<string, File | string>): Request {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return new Request(`${BASE}/api/items/photo`, { method: "POST", body: form });
}

function json(path: string, method: string, body?: unknown): Request {
  return new Request(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function errorOf(response: Response) {
  return ApiErrorSchema.parse(await response.json()).error;
}

const counted = () => fake.deps.usageStore.events.filter((e) => e.kind === "item_ingest").length;

async function jpegFile(name = "IMG_0001.jpg") {
  return file((await phoneJpeg({ width: 800, height: 600 })).data, name, "image/jpeg");
}

async function uploadDraft(): Promise<ItemDraft> {
  const res = await itemPhoto.POST(
    photoForm({ original: await jpegFile(), cutout: file((await cutoutPng()).data, "cutout.png", "image/png") }),
  );
  expect(res.status).toBe(200);
  return ItemDraftResponseSchema.parse(await res.json()).draft;
}

async function saveDraft(draft: ItemDraft) {
  const body: CreateItemRequest = {
    source: draft.source,
    sourceUrl: draft.sourceUrl,
    originalImageKey: draft.originalImageKey,
    cutoutImageKey: draft.cutoutImageKey,
    tags: TAGS,
    tagsEdited: false,
  };
  const res = await items.POST(json("/api/items", "POST", body));
  expect(res.status).toBe(201);
  return ItemResponseSchema.parse(await res.json()).item;
}

/** Store images directly in a user's folder (as an earlier upload would have). */
async function storedKeys(userId: string) {
  const originalImageKey = newImageKey(userId, "image/jpeg");
  const cutoutImageKey = newImageKey(userId, "image/png");
  await fake.deps.storage.upload(STORAGE_BUCKETS.originals, originalImageKey, await phoneJpeg());
  await fake.deps.storage.upload(STORAGE_BUCKETS.cutouts, cutoutImageKey, await cutoutPng());
  return { originalImageKey, cutoutImageKey };
}

function createBody(keys: { originalImageKey: string; cutoutImageKey: string | null }): CreateItemRequest {
  return { source: "photo", sourceUrl: null, ...keys, tags: TAGS, tagsEdited: false };
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

describe("POST /api/items/photo: claimed type vs real type", () => {
  it("an SVG named photo.jpg and sent as image/jpeg: 400, nothing stored or counted", async () => {
    const res = await itemPhoto.POST(photoForm({ original: file(HOSTILE_SVG, "photo.jpg", "image/jpeg") }));
    expect(res.status).toBe(400);
    expect((await errorOf(res)).issues?.[0]?.path).toBe("original");
    expect(fake.deps.storage.objects.size).toBe(0);
    expect(fake.deps.usageStore.events).toEqual([]);
  });

  it("an SVG sent as image/svg+xml cut-out: 400", async () => {
    const res = await itemPhoto.POST(
      photoForm({ original: await jpegFile(), cutout: file(HOSTILE_SVG, "cutout.svg", "image/svg+xml") }),
    );
    expect(res.status).toBe(400);
    expect((await errorOf(res)).issues?.[0]?.path).toBe("cutout");
    expect(counted()).toBe(0);
  });

  it("a GIF named .png: 400", async () => {
    const res = await itemPhoto.POST(photoForm({ original: file(GIF_BYTES, "x.png", "image/png") }));
    expect(res.status).toBe(400);
  });

  it("a JPEG sent as the cut-out (named .png, typed image/png): 400 on the cut-out, not counted", async () => {
    const res = await itemPhoto.POST(
      photoForm({ original: await jpegFile(), cutout: file((await phoneJpeg()).data, "cutout.png", "image/png") }),
    );
    expect(res.status).toBe(400);
    expect((await errorOf(res)).issues?.[0]?.path).toBe("cutout");
    expect(counted()).toBe(0);
  });

  it("a transparent WebP sent as the cut-out: 400", async () => {
    const webp = await webpWithExifAndXmp({ alpha: true });
    const res = await itemPhoto.POST(photoForm({ original: await jpegFile(), cutout: file(webp.data, "c.png", "image/png") }));
    expect(res.status).toBe(400);
  });

  it("a PNG named IMG.jpg and typed image/jpeg is accepted as the PNG it is", async () => {
    const res = await itemPhoto.POST(photoForm({ original: file((await cutoutPng()).data, "IMG.jpg", "image/jpeg") }));
    expect(res.status).toBe(200);
    const { draft } = ItemDraftResponseSchema.parse(await res.json());
    expect(draft.originalImageKey).toMatch(/\.png$/);
  });

  it("a decompression bomb: 400 naming the field, not a 500 or a crash", async () => {
    const res = await itemPhoto.POST(photoForm({ original: file((await pngBomb()).data, "bomb.png", "image/png") }));
    expect(res.status).toBe(400);
    expect((await errorOf(res)).issues?.[0]?.path).toBe("original");
    expect(counted()).toBe(0);
  });

  it("a javascript: source link is refused", async () => {
    const res = await itemPhoto.POST(photoForm({ original: await jpegFile(), sourceUrl: "javascript:alert(1)" }));
    expect(res.status).toBe(400);
    expect(counted()).toBe(0);
  });

  // Both were BUG pins (it.fails): 500 internal, and the original was counted.
  it("a truncated JPEG original answers 400 on `original` and isn't counted", async () => {
    const broken = truncated(await phoneJpeg({ width: 800, height: 600 }));
    const res = await itemPhoto.POST(photoForm({ original: file(broken.data, "IMG.jpg", "image/jpeg") }));
    expect({ status: res.status, counted: counted() }).toEqual({ status: 400, counted: 0 });
  });

  it("a truncated PNG cut-out answers 400 on `cutout` and isn't counted", async () => {
    const broken = truncated(await cutoutPng(), 0.6);
    const res = await itemPhoto.POST(photoForm({ original: await jpegFile(), cutout: file(broken.data, "c.png", "image/png") }));
    expect(res.status).toBe(400);
    const error = await errorOf(res);
    expect([error.code, error.issues?.[0]?.path, counted()]).toEqual(["bad_request", "cutout", 0]);
  });

  it("AI paused: 503 ai_paused, nothing stored, no usage rows added", async () => {
    await fake.deps.usage.recordAiCost(null, "tagging", 1, "gemini");
    const before = fake.deps.usageStore.events.length;
    const res = await itemPhoto.POST(photoForm({ original: await jpegFile() }));
    expect(res.status).toBe(503);
    expect((await errorOf(res)).code).toBe("ai_paused");
    expect(fake.deps.storage.objects.size).toBe(0);
    expect(fake.deps.usageStore.events).toHaveLength(before);
  });

  it("a refused upload doesn't use up the cap: 3 bad uploads, then 3 good ones still fit the cap of 3", async () => {
    for (let i = 0; i < 3; i++) {
      const res = await itemPhoto.POST(photoForm({ original: file(HOSTILE_SVG, "p.jpg", "image/jpeg") }));
      expect(res.status).toBe(400);
    }
    for (let i = 0; i < 3; i++) await uploadDraft();
    const res = await itemPhoto.POST(photoForm({ original: await jpegFile() }));
    expect(res.status).toBe(429);
  });
});

describe("items CRUD: someone else's item is a 404, and unchanged", () => {
  it("GET, PATCH and DELETE of another user's item all answer 404 not_found", async () => {
    const theirs = await saveDraft(await uploadDraft());
    fake.user = { id: OTHER_USER, email: "other@example.com" };

    const get = await itemById.GET(json(`/api/items/${theirs.id}`, "GET"), ctx(theirs.id));
    const patch = await itemById.PATCH(
      json(`/api/items/${theirs.id}`, "PATCH", { tags: { ...TAGS, description: "Hijacked" } }),
      ctx(theirs.id),
    );
    const del = await itemById.DELETE(json(`/api/items/${theirs.id}`, "DELETE"), ctx(theirs.id));
    for (const res of [get, patch, del]) {
      expect(res.status).toBe(404);
      expect((await errorOf(res)).code).toBe("not_found");
    }

    // Still there, unedited, with its images.
    const row = fake.deps.items.rows.get(theirs.id)!;
    expect(row.description).toBe(TAGS.description);
    expect(row.tags_edited).toBe(false);
    expect(await fake.deps.storage.exists(STORAGE_BUCKETS.originals, row.original_image_key)).toBe(true);
    expect(await fake.deps.storage.exists(STORAGE_BUCKETS.cutouts, row.cutout_image_key!)).toBe(true);
  });

  it("another user's list doesn't include it", async () => {
    await saveDraft(await uploadDraft());
    fake.user = { id: OTHER_USER, email: "other@example.com" };
    const res = await items.GET(json("/api/items", "GET"));
    expect((await res.json()).items).toEqual([]);
  });

  it("a malformed id is a 404, not a 400 or 500", async () => {
    for (const id of ["not-a-uuid", "' or 1=1 --", "%00"]) {
      const res = await itemById.GET(json(`/api/items/x`, "GET"), ctx(id));
      expect(res.status).toBe(404);
    }
  });
});

describe("items CRUD: PATCH and DELETE", () => {
  it("PATCH sets tagsEdited even when the item was saved with tagsEdited false and the tags are the same", async () => {
    const item = await saveDraft(await uploadDraft());
    expect(item.tagsEdited).toBe(false);
    const res = await itemById.PATCH(json(`/api/items/${item.id}`, "PATCH", { tags: TAGS }), ctx(item.id));
    expect(res.status).toBe(200);
    expect(ItemResponseSchema.parse(await res.json()).item.tagsEdited).toBe(true);
  });

  it("PATCH with partial tags is refused (the form sends all of them) and changes nothing", async () => {
    const item = await saveDraft(await uploadDraft());
    const res = await itemById.PATCH(json(`/api/items/${item.id}`, "PATCH", { tags: { description: "x" } }), ctx(item.id));
    expect(res.status).toBe(400);
    expect(fake.deps.items.rows.get(item.id)!.tags_edited).toBe(false);
  });

  it("PATCH with a subcategory from another category is refused", async () => {
    const item = await saveDraft(await uploadDraft());
    const res = await itemById.PATCH(
      json(`/api/items/${item.id}`, "PATCH", { tags: { ...TAGS, category: "shoes" } }),
      ctx(item.id),
    );
    expect(res.status).toBe(400);
  });

  it("DELETE removes the item and both images; a second DELETE is a 404", async () => {
    const draft = await uploadDraft();
    const item = await saveDraft(draft);
    const res = await itemById.DELETE(json(`/api/items/${item.id}`, "DELETE"), ctx(item.id));
    expect(res.status).toBe(200);
    expect(await fake.deps.storage.exists(STORAGE_BUCKETS.originals, draft.originalImageKey)).toBe(false);
    expect(await fake.deps.storage.exists(STORAGE_BUCKETS.cutouts, draft.cutoutImageKey!)).toBe(false);
    expect(fake.deps.storage.objects.size).toBe(0);
    const again = await itemById.DELETE(json(`/api/items/${item.id}`, "DELETE"), ctx(item.id));
    expect(again.status).toBe(404);
  });
});

describe("POST /api/items: which image keys a draft may use", () => {
  it("someone else's keys: 400 and no row", async () => {
    const keys = await storedKeys(OTHER_USER);
    const res = await items.POST(json("/api/items", "POST", createBody(keys)));
    expect(res.status).toBe(400);
    expect(fake.deps.items.rows.size).toBe(0);
  });

  it("own original with someone else's cut-out: 400", async () => {
    const mine = await storedKeys(TEST_USER);
    const theirs = await storedKeys(OTHER_USER);
    const res = await items.POST(
      json("/api/items", "POST", createBody({ originalImageKey: mine.originalImageKey, cutoutImageKey: theirs.cutoutImageKey })),
    );
    expect(res.status).toBe(400);
    expect(fake.deps.items.rows.size).toBe(0);
  });

  it("a key that climbs out of the user's folder is refused by the key format", async () => {
    const theirs = await storedKeys(OTHER_USER);
    const sneaky = `${TEST_USER}/../${theirs.originalImageKey}`;
    const res = await items.POST(json("/api/items", "POST", createBody({ originalImageKey: sneaky, cutoutImageKey: null })));
    expect(res.status).toBe(400);
    expect(fake.deps.items.rows.size).toBe(0);
  });

  it("keys in the user's folder that were never uploaded: 400", async () => {
    const res = await items.POST(
      json("/api/items", "POST", createBody({ originalImageKey: newImageKey(TEST_USER, "image/jpeg"), cutoutImageKey: null })),
    );
    expect(res.status).toBe(400);
  });

  it("an original key passed as the cut-out (wrong bucket): 400", async () => {
    const mine = await storedKeys(TEST_USER);
    const other = await storedKeys(TEST_USER);
    const res = await items.POST(
      json("/api/items", "POST", createBody({ originalImageKey: mine.originalImageKey, cutoutImageKey: other.originalImageKey })),
    );
    expect(res.status).toBe(400);
  });

  it("keys already used by a saved item, alone or mixed with fresh ones: 400", async () => {
    const draft = await uploadDraft();
    await saveDraft(draft);
    const fresh = await storedKeys(TEST_USER);
    for (const keys of [
      { originalImageKey: draft.originalImageKey, cutoutImageKey: draft.cutoutImageKey },
      { originalImageKey: draft.originalImageKey, cutoutImageKey: fresh.cutoutImageKey },
      { originalImageKey: fresh.originalImageKey, cutoutImageKey: draft.cutoutImageKey },
      { originalImageKey: draft.originalImageKey, cutoutImageKey: null },
    ]) {
      const res = await items.POST(json("/api/items", "POST", createBody(keys)));
      expect(res.status).toBe(400);
    }
    expect(fake.deps.items.rows.size).toBe(1);
  });

  it("source link without a sourceUrl is refused", async () => {
    const keys = await storedKeys(TEST_USER);
    const res = await items.POST(json("/api/items", "POST", { ...createBody(keys), source: "link", sourceUrl: null }));
    expect(res.status).toBe(400);
  });
});

describe("GET /api/items search", () => {
  it("% and _ are literal in the search", async () => {
    const a = await saveDraft(await uploadDraft());
    fake.deps.items.rows.get(a.id)!.description = "Navy 100% cotton t_shirt";
    const b = await saveDraft(await uploadDraft());
    fake.deps.items.rows.get(b.id)!.description = "Navy 100 cotton tshirt";

    const pct = await (await items.GET(json("/api/items?q=100%25", "GET"))).json();
    expect(pct.items.map((i: { id: string }) => i.id)).toEqual([a.id]);
    const under = await (await items.GET(json("/api/items?q=t_shirt", "GET"))).json();
    expect(under.items.map((i: { id: string }) => i.id)).toEqual([a.id]);
  });
});
