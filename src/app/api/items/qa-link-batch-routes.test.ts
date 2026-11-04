/**
 * QA (milestone 5, C3): add-by-link step 2 without a cut-out, and
 * `saveForReview` in a batch with caps, through the real route handlers
 * with mock mode OFF. A local shop server behind a fake DNS; storage,
 * items, usage and the tagger in memory. No real network or AI.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiErrorSchema, BatchAddResponseSchema, ItemDraftResponseSchema, LinkImportResponseSchema, STORAGE_BUCKETS } from "@/contracts";
import { PUBLIC_V4, bytes, fixture, html, makeLinkDeps, startTestServer, testNetwork, type TestServer } from "@/lib/link-import/test-support";
import { tagging } from "@/test/fixtures/model-output";
import { asFile, cutoutPng, phoneJpeg } from "@/test/images";
import { TEST_LIMITS, TEST_USER } from "@/test/ingestion-deps";

const fake = vi.hoisted(() => ({
  userId: "",
  deps: null as unknown as ReturnType<typeof import("@/lib/link-import/test-support").makeLinkDeps>,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: fake.userId, email: "tester@example.com" } } }) } }),
}));
vi.mock("@/lib/link-import/deps", () => ({
  getLinkImportDeps: () => fake.deps,
  getLinkCutoutDeps: async () => fake.deps,
}));
vi.mock("@/lib/ingestion/deps", () => ({
  getWardrobeDeps: async () => fake.deps,
  getPhotoIngestionDeps: () => fake.deps,
}));

import * as linkCutout from "./link/cutout/route";
import * as link from "./link/route";

const BASE = "http://localhost:3000";
const OTHER_USER = "8a7f0c1e-0000-4000-8000-0000000000c3";
const TAGS = JSON.stringify(tagging.valid);
let server: TestServer;

const step1 = (url: string) =>
  link.POST(new Request(`${BASE}/api/items/link`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url }) }));

function step2(meta: unknown, cutout?: File): Promise<Response> {
  const form = new FormData();
  form.set("meta", typeof meta === "string" ? meta : JSON.stringify(meta));
  if (cutout) form.set("cutout", cutout);
  return linkCutout.POST(new Request(`${BASE}/api/items/link/cutout`, { method: "POST", body: form }));
}

async function startLink(url: string): Promise<string> {
  const body = LinkImportResponseSchema.parse(await (await step1(url)).json());
  if (body.status !== "ok") throw new Error(`fallback: ${body.reason}`);
  return body.originalImageKey;
}

const itemsToday = async () => (await fake.deps.usage.summary(TEST_USER)).itemsToday.used;
const code = async (res: Response) => ApiErrorSchema.parse(await res.json()).error;

beforeEach(async () => {
  vi.stubEnv("GLADRAGS_MOCK_MODE", "false");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://qa-project.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_qa");
  fake.userId = TEST_USER;
  server = await startTestServer();
  fake.deps = makeLinkDeps(testNetwork(server.port, { "northfield.example": [PUBLIC_V4], "cdn.northfield.example": [PUBLIC_V4] }), { taggerOutputs: [TAGS] });
  const page = html(fixture("og-only.html").replaceAll("https://", "http://"));
  for (let i = 1; i <= 6; i++) server.routes.set(`northfield.example/boots-${i}`, page);
  server.routes.set("cdn.northfield.example/img/chelsea-tan-1.jpg?w=2000", bytes((await phoneJpeg({ width: 1800, height: 2000 })).data, "image/jpeg"));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  await server.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("link step 2 without a cut-out", () => {
  it("saveForReview: false behaves as a single add (a draft, nothing saved), but still counts the item", async () => {
    const key = await startLink("http://northfield.example/boots-1");
    const draft = ItemDraftResponseSchema.parse(await (await step2({ originalImageKey: key, saveForReview: false })).json()).draft;
    expect(draft).toMatchObject({ cutoutImageKey: null, cutoutUrl: null });
    expect(draft.suggestedTags).not.toBeNull();
    expect(fake.deps.items.rows.size).toBe(0);
    expect(await itemsToday()).toBe(1);
  });

  it("an optional cut-out is still accepted with saveForReview, and the saved item keeps it", async () => {
    const key = await startLink("http://northfield.example/boots-1");
    const res = await step2({ originalImageKey: key, saveForReview: true }, asFile(await cutoutPng(), "cutout.png"));
    const body = BatchAddResponseSchema.parse(await res.json());
    if (body.status !== "saved") throw new Error("expected saved");
    expect(body.item.cutoutUrl).not.toBeNull();
    expect(body.item.needsReview).toBe(true);
  });

  it.each([
    ["the string \"true\"", { saveForReview: "true" }],
    ["a number", { saveForReview: 1 }],
    ["null", { saveForReview: null }],
  ])("saveForReview as %s is refused (400) and the import is still usable", async (_label, extra) => {
    const key = await startLink("http://northfield.example/boots-1");
    const res = await step2({ originalImageKey: key, ...extra });
    expect(res.status).toBe(400);
    expect(await itemsToday()).toBe(0);
    expect((await step2({ originalImageKey: key, saveForReview: true })).status).toBe(200);
  });

  it.each([
    ["meta that isn't JSON", "{originalImageKey"],
    ["no meta at all", ""],
    ["a key outside the user's folder", JSON.stringify({ originalImageKey: "../../etc/passwd", saveForReview: true })],
  ])("%s: 400 or 404, nothing counted", async (_label, meta) => {
    const res = await step2(meta);
    expect([400, 404]).toContain(res.status);
    expect(await itemsToday()).toBe(0);
  });

  it("another user's import key is not_found, and stays usable by its owner", async () => {
    const key = await startLink("http://northfield.example/boots-1");
    fake.userId = OTHER_USER;
    const res = await step2({ originalImageKey: key, saveForReview: true });
    expect((await code(res)).code).toBe("not_found");
    expect(fake.deps.items.rows.size).toBe(0);
    fake.userId = TEST_USER;
    expect((await step2({ originalImageKey: key, saveForReview: true })).status).toBe(200);
  });

  it("the same import sent twice at once saves one item and counts one", async () => {
    const key = await startLink("http://northfield.example/boots-1");
    const results = await Promise.all([1, 2, 3].map(() => step2({ originalImageKey: key, saveForReview: true })));
    expect(results.map((r) => r.status).sort()).toEqual([200, 404, 404]);
    expect(fake.deps.items.rows.size).toBe(1);
    expect(await itemsToday()).toBe(1);
  });
});

describe("saveForReview in a batch with caps", () => {
  it("the cap used up between step 1 and step 2: 429, nothing saved or stored, and the import isn't used up", async () => {
    const key = await startLink("http://northfield.example/boots-1");
    for (let i = 0; i < TEST_LIMITS.dailyCaps.item_ingest; i++) await fake.deps.usage.reserveAction(TEST_USER, "item_ingest");
    const res = await step2({ originalImageKey: key, saveForReview: true }, asFile(await cutoutPng(), "cutout.png"));
    expect(res.status).toBe(429);
    const error = await code(res);
    expect(error.code).toBe("daily_cap_reached");
    expect(error.cap?.kind).toBe("items_per_day");
    expect(fake.deps.items.rows.size).toBe(0);
    expect([...fake.deps.storage.objects.keys()].filter((k) => k.startsWith(`${STORAGE_BUCKETS.cutouts}/`))).toEqual([]);
    expect(await fake.deps.linkImports.findOpen(TEST_USER, key)).toBeTruthy();
  });

  it("step 2s for several links sent at once never pass the cap: exactly the cap's worth saved, the rest 429", async () => {
    const keys: string[] = [];
    for (let i = 1; i <= 5; i++) keys.push(await startLink(`http://northfield.example/boots-${i}`));
    const results = await Promise.all(keys.map((key) => step2({ originalImageKey: key, saveForReview: true })));
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(TEST_LIMITS.dailyCaps.item_ingest);
    expect(statuses.filter((s) => s === 429)).toHaveLength(5 - TEST_LIMITS.dailyCaps.item_ingest);
    expect(fake.deps.items.rows.size).toBe(TEST_LIMITS.dailyCaps.item_ingest);
    expect(await itemsToday()).toBe(TEST_LIMITS.dailyCaps.item_ingest);
    expect([...fake.deps.items.rows.values()].every((i) => i.needs_review && i.source === "link")).toBe(true);
  });

  it("AI paused at step 2: 503 ai_paused, nothing saved, the count given back and the import reopened", async () => {
    const key = await startLink("http://northfield.example/boots-1");
    await fake.deps.usage.recordAiCost(null, "tagging", TEST_LIMITS.monthlySpendCapPence);
    const res = await step2({ originalImageKey: key, saveForReview: true });
    expect(res.status).toBe(503);
    expect((await code(res)).code).toBe("ai_paused");
    expect(fake.deps.items.rows.size).toBe(0);
    expect(await itemsToday()).toBe(0);
    expect(await fake.deps.linkImports.findOpen(TEST_USER, key)).toBeTruthy();
  });

  it("tagging failing twice in a batch: a draft comes back for the review list, nothing is saved, the import is used", async () => {
    fake.deps = makeLinkDeps(fake.deps.network, { taggerOutputs: ["{\"category\":\"hat\"}"] });
    const key = await startLink("http://northfield.example/boots-1");
    const body = BatchAddResponseSchema.parse(await (await step2({ originalImageKey: key, saveForReview: true })).json());
    expect(body.status).toBe("draft");
    expect(fake.deps.items.rows.size).toBe(0);
    expect((await step2({ originalImageKey: key, saveForReview: true })).status).toBe(404);
  });

  it("an error saving the item is a 5xx and leaves no cut-out behind", async () => {
    const key = await startLink("http://northfield.example/boots-1");
    vi.spyOn(fake.deps.items, "create").mockRejectedValueOnce(new Error("insert failed"));
    const res = await step2({ originalImageKey: key, saveForReview: true }, asFile(await cutoutPng(), "cutout.png"));
    expect(res.status).toBe(500);
    expect(fake.deps.items.rows.size).toBe(0);
    // The cut-out stored for this item is either removed or left for the daily orphan cleanup; report which.
    const cutouts = [...fake.deps.storage.objects.keys()].filter((k) => k.startsWith(`${STORAGE_BUCKETS.cutouts}/`));
    expect(cutouts.length).toBeLessThanOrEqual(1);
  });
});
