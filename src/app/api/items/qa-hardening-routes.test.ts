/**
 * QA (fix/hardening) through the real route handlers, mock mode OFF:
 * parallel uploads against the daily item cap, and simultaneous saves of
 * one draft (the unique image keys).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiErrorSchema, ItemDraftResponseSchema, STORAGE_BUCKETS, type ItemDraft, type ItemTags } from "@/contracts";
import { tagging } from "@/test/fixtures/model-output";
import { asFile, cutoutPng, phoneJpeg } from "@/test/images";
import { TEST_LIMITS, TEST_USER, makeTestDeps } from "@/test/ingestion-deps";

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

import * as itemPhoto from "./photo/route";
import * as items from "./route";

const BASE = "http://localhost:3000";

async function photoRequest(withCutout = true): Promise<Request> {
  const form = new FormData();
  form.set("original", asFile(await phoneJpeg({ width: 800, height: 600 }), "IMG_0001.jpg"));
  if (withCutout) form.set("cutout", asFile(await cutoutPng({ width: 400, height: 300 }), "cutout.png"));
  return new Request(`${BASE}/api/items/photo`, { method: "POST", body: form });
}

function saveRequest(draft: ItemDraft): Request {
  return new Request(`${BASE}/api/items`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({
      source: draft.source,
      sourceUrl: draft.sourceUrl,
      originalImageKey: draft.originalImageKey,
      cutoutImageKey: draft.cutoutImageKey,
      tags: tagging.valid as ItemTags,
      tagsEdited: false,
    }),
  });
}

async function newDraft(): Promise<ItemDraft> {
  const res = await itemPhoto.POST(await photoRequest());
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

describe("POST /api/items/photo under a burst", () => {
  it(`12 uploads at once with a cap of ${TEST_LIMITS.dailyCaps.item_ingest}: exactly that many drafts, the rest 429, and no images left behind`, async () => {
    const requests = await Promise.all(Array.from({ length: 12 }, () => photoRequest()));
    const responses = await Promise.all(requests.map((r) => itemPhoto.POST(r)));
    const statuses = responses.map((r) => r.status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(TEST_LIMITS.dailyCaps.item_ingest);
    expect(statuses.filter((s) => s === 429)).toHaveLength(12 - TEST_LIMITS.dailyCaps.item_ingest);
    for (const res of responses.filter((r) => r.status === 429)) {
      const { error } = ApiErrorSchema.parse(await res.json());
      expect(error.code).toBe("daily_cap_reached");
      expect(error.cap?.kind).toBe("items_per_day");
    }
    expect(fake.deps.usageStore.events.filter((e) => e.kind === "item_ingest")).toHaveLength(TEST_LIMITS.dailyCaps.item_ingest);
    // Uploads refused at the count had their images removed again.
    const originals = [...fake.deps.storage.objects.keys()].filter((k) => k.startsWith(`${STORAGE_BUCKETS.originals}/`));
    const cutouts = [...fake.deps.storage.objects.keys()].filter((k) => k.startsWith(`${STORAGE_BUCKETS.cutouts}/`));
    expect(originals).toHaveLength(TEST_LIMITS.dailyCaps.item_ingest);
    expect(cutouts).toHaveLength(TEST_LIMITS.dailyCaps.item_ingest);
  });

  it("tagging calls are only made for counted uploads", async () => {
    const requests = await Promise.all(Array.from({ length: 8 }, () => photoRequest(false)));
    await Promise.all(requests.map((r) => itemPhoto.POST(r)));
    expect(fake.deps.fakeTagger.calls).toHaveLength(TEST_LIMITS.dailyCaps.item_ingest);
  });
});

describe("POST /api/items: simultaneous saves of one draft", () => {
  it("two at once: exactly one item (201) and one bad_request", async () => {
    const draft = await newDraft();
    const [a, b] = await Promise.all([items.POST(saveRequest(draft)), items.POST(saveRequest(draft))]);
    expect([a.status, b.status].sort()).toEqual([201, 400]);
    const loser = a.status === 400 ? a : b;
    const { error } = ApiErrorSchema.parse(await loser.json());
    expect(error).toMatchObject({ code: "bad_request", message: "That item has already been saved" });
    expect(fake.deps.items.rows.size).toBe(1);
  });

  it("ten at once: still exactly one item", async () => {
    const draft = await newDraft();
    const responses = await Promise.all(Array.from({ length: 10 }, () => items.POST(saveRequest(draft))));
    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
    expect(responses.filter((r) => r.status === 400)).toHaveLength(9);
    expect(fake.deps.items.rows.size).toBe(1);
  });

  it("a forged draft reusing only another item's cut-out key is refused too", async () => {
    const first = await newDraft();
    expect((await items.POST(saveRequest(first))).status).toBe(201);
    const second = await newDraft();
    const res = await items.POST(saveRequest({ ...second, cutoutImageKey: first.cutoutImageKey }));
    expect(res.status).toBe(400);
    expect(fake.deps.items.rows.size).toBe(1);
  });
});
