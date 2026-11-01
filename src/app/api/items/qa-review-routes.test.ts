/**
 * QA gap tests for the milestone 5 ingestion routes through the real
 * handlers, mock mode off: invalid input on every new route, upload files
 * the parser must refuse, and that the review routes see only the signed-in
 * user's items. In-memory storage and items, a fake tagger, a real
 * UsageGuard, real image checks (sharp). No network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiErrorSchema,
  BatchAddResponseSchema,
  ItemDraftResponseSchema,
  ItemListResponseSchema,
  MAX_CUTOUT_BYTES,
  MAX_ITEMS_PER_REVIEW,
  MAX_ORIGINAL_BYTES,
  MarkItemsReviewedResponseSchema,
  type WardrobeItem,
} from "@/contracts";
import { tagging } from "@/test/fixtures/model-output";
import { asFile, cutoutPng, phoneJpeg, phoneWebp } from "@/test/images";
import { OTHER_USER, TEST_USER, makeTestDeps } from "@/test/ingestion-deps";
import { GIF_BYTES, HOSTILE_SVG, webpWithExifAndXmp } from "@/test/qa-hostile-images";

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
const ME = { id: TEST_USER, email: "tester@example.com" };
const THEM = { id: OTHER_USER, email: "other@example.com" };

function json(path: string, method: string, body?: unknown): Request {
  return new Request(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
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

async function batchAdd(as = ME): Promise<WardrobeItem> {
  fake.user = as;
  const res = await itemPhoto.POST(
    multipart("/api/items/photo", "POST", { original: asFile(await phoneJpeg({ width: 600, height: 800 }), "IMG.jpg"), saveForReview: "true" }),
  );
  expect(res.status).toBe(200);
  const body = BatchAddResponseSchema.parse(await res.json());
  if (body.status !== "saved") throw new Error("expected a saved item");
  fake.user = ME;
  return body.item;
}

async function list(query = ""): Promise<WardrobeItem[]> {
  const res = await items.GET(new Request(`${BASE}/api/items${query}`));
  expect(res.status).toBe(200);
  return ItemListResponseSchema.parse(await res.json()).items;
}

/** A file that starts like the given type and is padded past the size limit. */
function paddedFile(head: Uint8Array, bytes: number, name: string): File {
  const data = new Uint8Array(bytes);
  data.set(head.subarray(0, Math.min(head.length, bytes)));
  return new File([data], name);
}

beforeEach(() => {
  vi.stubEnv("GLADRAGS_MOCK_MODE", "false");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://qa-project.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_qa");
  fake.user = ME;
  fake.deps = makeTestDeps({ taggerOutputs: [JSON.stringify(tagging.valid)] });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("signed out: every new route answers 401 and touches nothing", () => {
  it("all of them", async () => {
    const item = await batchAdd();
    fake.user = null;
    const responses = [
      await items.GET(new Request(`${BASE}/api/items?needsReview=true`)),
      await reviewed.POST(json("/api/items/reviewed", "POST", { itemIds: [item.id] })),
      await itemById.PATCH(json(`/api/items/${item.id}`, "PATCH", { reviewed: true }), ctx(item.id)),
      await itemCutout.PUT(multipart(`/api/items/${item.id}/cutout`, "PUT", { cutout: asFile(await cutoutPng(), "c.png") }), ctx(item.id)),
      await itemPhotoReplace.PUT(multipart(`/api/items/${item.id}/photo`, "PUT", { original: asFile(await phoneJpeg(), "p.jpg") }), ctx(item.id)),
    ];
    expect(responses.map((r) => r.status)).toEqual([401, 401, 401, 401, 401]);
    expect((await fake.deps.items.get(TEST_USER, item.id))!.needs_review).toBe(true);
  });
});

describe("POST /api/items/photo with saveForReview", () => {
  it("saveForReview=false gives a draft and saves nothing", async () => {
    const res = await itemPhoto.POST(multipart("/api/items/photo", "POST", { original: asFile(await phoneJpeg(), "a.jpg"), saveForReview: "false" }));
    expect(ItemDraftResponseSchema.parse(await res.json()).draft.suggestedTags).not.toBeNull();
    expect(fake.deps.items.rows.size).toBe(0);
  });

  // z.stringbool() in the contract also reads "yes", "1", "on" as true; only other text is refused.
  it.each(["TRUEISH", "null", "2"])("saveForReview=%j is 400 on the field, before anything is counted or stored", async (value) => {
    const res = await itemPhoto.POST(multipart("/api/items/photo", "POST", { original: asFile(await phoneJpeg(), "a.jpg"), saveForReview: value }));
    expect(res.status).toBe(400);
    expect((await errorOf(res)).issues?.[0]?.path).toBe("saveForReview");
    expect(fake.deps.usageStore.events).toEqual([]);
    expect(fake.deps.storage.objects.size).toBe(0);
  });

  it("a tagging failure gives a draft that matches BatchAddResponseSchema and is not listed", async () => {
    fake.deps = makeTestDeps({ taggerOutputs: ["{}"] });
    const res = await itemPhoto.POST(multipart("/api/items/photo", "POST", { original: asFile(await phoneJpeg(), "a.jpg"), saveForReview: "true" }));
    expect(res.status).toBe(200);
    expect(BatchAddResponseSchema.parse(await res.json()).status).toBe("draft");
    expect(await list("?needsReview=true")).toEqual([]);
  });

  it("a fourth photo past the cap: 429, nothing stored or saved for it", async () => {
    for (let i = 0; i < 3; i++) await batchAdd();
    const res = await itemPhoto.POST(multipart("/api/items/photo", "POST", { original: asFile(await phoneJpeg(), "a.jpg"), saveForReview: "true" }));
    expect(res.status).toBe(429);
    expect(fake.deps.items.rows.size).toBe(3);
    expect(fake.deps.storage.objects.size).toBe(3);
  });
});

describe("GET /api/items?needsReview=", () => {
  it("only the signed-in user's items, either way", async () => {
    const mine = await batchAdd();
    const theirs = await batchAdd(THEM);
    expect((await list("?needsReview=true")).map((i) => i.id)).toEqual([mine.id]);
    expect(await list("?needsReview=false")).toEqual([]);
    fake.user = THEM;
    expect((await list("?needsReview=true")).map((i) => i.id)).toEqual([theirs.id]);
  });

  it.each(["maybe", "", "TRUE!", "2"])("needsReview=%j is a 400, not everything", async (value) => {
    await batchAdd();
    const res = await items.GET(new Request(`${BASE}/api/items?needsReview=${encodeURIComponent(value)}`));
    // An empty value may reasonably mean "no filter"; anything else must be refused.
    if (value === "" && res.status === 200) return;
    expect(res.status).toBe(400);
  });
});

describe("POST /api/items/reviewed", () => {
  it.each([
    ["no body", undefined],
    ["not JSON", "{itemIds:"],
    ["an empty list", { itemIds: [] }],
    ["duplicates", { itemIds: ["1a000000-0000-4000-8000-000000000001", "1a000000-0000-4000-8000-000000000001"] }],
    ["not UUIDs", { itemIds: ["../../etc", "1 OR 1=1"] }],
    ["too many", { itemIds: Array.from({ length: MAX_ITEMS_PER_REVIEW + 1 }, (_, i) => `1a000000-0000-4000-8000-${String(i).padStart(12, "0")}`) }],
    ["a string instead of a list", { itemIds: "1a000000-0000-4000-8000-000000000001" }],
  ])("%s: 400 and nothing changes", async (_label, body) => {
    const item = await batchAdd();
    const res = await reviewed.POST(json("/api/items/reviewed", "POST", body));
    expect(res.status).toBe(400);
    expect((await fake.deps.items.get(TEST_USER, item.id))!.needs_review).toBe(true);
  });

  it("exactly the maximum is accepted", async () => {
    const item = await batchAdd();
    const ids = [item.id, ...Array.from({ length: MAX_ITEMS_PER_REVIEW - 1 }, (_, i) => `1a000000-0000-4000-8000-${String(i).padStart(12, "0")}`)];
    const res = await reviewed.POST(json("/api/items/reviewed", "POST", { itemIds: ids }));
    expect(MarkItemsReviewedResponseSchema.parse(await res.json())).toEqual({ updated: 1 });
  });

  it("counts and changes only the user's items; the other user's stay to review", async () => {
    const mine = await batchAdd();
    const theirs = await batchAdd(THEM);
    const res = await reviewed.POST(json("/api/items/reviewed", "POST", { itemIds: [theirs.id, mine.id] }));
    expect(MarkItemsReviewedResponseSchema.parse(await res.json())).toEqual({ updated: 1 });
    expect((await fake.deps.items.get(OTHER_USER, theirs.id))!.needs_review).toBe(true);
    expect((await fake.deps.items.get(TEST_USER, mine.id))!.needs_review).toBe(false);
  });
});

describe("PATCH /api/items/:id", () => {
  it.each([
    ["reviewed: false", { reviewed: false }],
    ["an empty body", {}],
    ["reviewed as a string", { reviewed: "true" }],
    ["tags that break the contract", { tags: { ...tagging.valid, category: "hat" } }],
  ])("%s: 400 and the item stays to review", async (_label, body) => {
    const item = await batchAdd();
    const res = await itemById.PATCH(json(`/api/items/${item.id}`, "PATCH", body), ctx(item.id));
    expect(res.status).toBe(400);
    expect((await fake.deps.items.get(TEST_USER, item.id))!.needs_review).toBe(true);
  });

  it("someone else's item: 404 and unchanged", async () => {
    const theirs = await batchAdd(THEM);
    const res = await itemById.PATCH(json(`/api/items/${theirs.id}`, "PATCH", { reviewed: true }), ctx(theirs.id));
    expect(res.status).toBe(404);
    expect((await fake.deps.items.get(OTHER_USER, theirs.id))!.needs_review).toBe(true);
  });

  it("a malformed item ID: 404 (parseRouteParams treats it as missing)", async () => {
    const res = await itemById.PATCH(json("/api/items/not-a-uuid", "PATCH", { reviewed: true }), ctx("not-a-uuid"));
    expect(res.status).toBe(404);
  });
});

describe("PUT /api/items/:id/cutout: the parser refuses", () => {
  it.each([
    ["a GIF", () => new File([GIF_BYTES], "c.png", { type: "image/png" })],
    ["an SVG named .png", () => new File([HOSTILE_SVG], "c.png", { type: "image/png" })],
    ["a WebP with alpha", async () => asFile(await webpWithExifAndXmp({ alpha: true }), "c.webp")],
    ["a file over the size limit", async () => paddedFile((await cutoutPng()).data, MAX_CUTOUT_BYTES + 1, "big.png")],
    ["text, not a file", () => "iVBORw0KGgo="],
  ])("%s: 400, nothing stored", async (_label, make) => {
    const item = await batchAdd();
    const before = fake.deps.storage.objects.size;
    const res = await itemCutout.PUT(multipart(`/api/items/${item.id}/cutout`, "PUT", { cutout: await make() }), ctx(item.id));
    expect(res.status).toBe(400);
    expect((await errorOf(res)).issues?.[0]?.path).toBe("cutout");
    expect(fake.deps.storage.objects.size).toBe(before);
  });

  it("a JSON body instead of multipart: 400", async () => {
    const item = await batchAdd();
    const res = await itemCutout.PUT(json(`/api/items/${item.id}/cutout`, "PUT", { cutout: "x" }), ctx(item.id));
    expect(res.status).toBe(400);
  });

  it("a malformed item ID: 404, nothing stored", async () => {
    const res = await itemCutout.PUT(multipart("/api/items/x/cutout", "PUT", { cutout: asFile(await cutoutPng(), "c.png") }), ctx("x"));
    expect(res.status).toBe(404);
    expect(fake.deps.storage.objects.size).toBe(0);
  });

  it("an opaque PNG through the route: 400 on cutout, item unchanged", async () => {
    const item = await batchAdd();
    const res = await itemCutout.PUT(multipart(`/api/items/${item.id}/cutout`, "PUT", { cutout: asFile(await phoneJpeg(), "c.png") }), ctx(item.id));
    expect(res.status).toBe(400);
    expect((await fake.deps.items.get(TEST_USER, item.id))!.cutout_image_key).toBeNull();
  });
});

describe("PUT /api/items/:id/photo: the parser refuses", () => {
  it.each([
    ["an SVG", () => new File([HOSTILE_SVG], "p.jpg", { type: "image/jpeg" })],
    ["a file over the size limit", async () => paddedFile((await phoneJpeg()).data, MAX_ORIGINAL_BYTES + 1, "big.jpg")],
    ["a missing file", null],
  ])("%s: 400, the item still needs its photo", async (_label, make) => {
    const item = await batchAdd();
    const before = fake.deps.storage.objects.size;
    const fields: Record<string, string | File> = make ? { original: await make() } : {};
    const res = await itemPhotoReplace.PUT(multipart(`/api/items/${item.id}/photo`, "PUT", fields), ctx(item.id));
    expect(res.status).toBe(400);
    expect((await errorOf(res)).issues?.[0]?.path).toBe("original");
    expect(fake.deps.storage.objects.size).toBe(before);
  });

  it("someone else's item: 404, their files untouched", async () => {
    const theirs = await batchAdd(THEM);
    const before = new Set(fake.deps.storage.objects.keys());
    const res = await itemPhotoReplace.PUT(multipart(`/api/items/${theirs.id}/photo`, "PUT", { original: asFile(await phoneWebp(), "p.webp") }), ctx(theirs.id));
    expect(res.status).toBe(404);
    expect(new Set(fake.deps.storage.objects.keys())).toEqual(before);
  });
});
