/**
 * Several links at once, through the real route handlers with mock mode
 * OFF: the phone runs step 1 then step 2 (no cut-out, `saveForReview`)
 * for each link in turn. Shops are a local test server behind a fake DNS;
 * storage, items, usage and the tagger are in memory. No real network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiErrorSchema, BatchAddResponseSchema, ItemDraftResponseSchema, ItemListResponseSchema, LinkImportResponseSchema } from "@/contracts";
import { PUBLIC_V4, bytes, fixture, html, makeLinkDeps, startTestServer, testNetwork, type TestServer } from "@/lib/link-import/test-support";
import { tagging } from "@/test/fixtures/model-output";
import { phoneJpeg } from "@/test/images";
import { TEST_LIMITS, TEST_USER } from "@/test/ingestion-deps";

const fake = vi.hoisted(() => ({
  deps: null as unknown as ReturnType<typeof import("@/lib/link-import/test-support").makeLinkDeps>,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: TEST_USER, email: "tester@example.com" } } }) } }),
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
import * as items from "./route";

const BASE = "http://localhost:3000";
let server: TestServer;

const step1 = (url: string) =>
  link.POST(new Request(`${BASE}/api/items/link`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url }) }));

function step2(meta: unknown): Promise<Response> {
  const form = new FormData();
  form.set("meta", JSON.stringify(meta));
  return linkCutout.POST(new Request(`${BASE}/api/items/link/cutout`, { method: "POST", body: form }));
}

/** Both steps for one link, as the phone does in a batch. */
async function addLink(url: string): Promise<Response> {
  const res1 = await step1(url);
  if (res1.status !== 200) return res1;
  const body = LinkImportResponseSchema.parse(await res1.json());
  if (body.status !== "ok") throw new Error(`fallback: ${body.reason}`);
  return step2({ originalImageKey: body.originalImageKey, saveForReview: true });
}

beforeEach(async () => {
  vi.stubEnv("GLADRAGS_MOCK_MODE", "false");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://qa-project.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_qa");
  server = await startTestServer();
  fake.deps = makeLinkDeps(testNetwork(server.port, { "northfield.example": [PUBLIC_V4], "cdn.northfield.example": [PUBLIC_V4] }), {
    taggerOutputs: [JSON.stringify(tagging.valid)],
  });
  const page = html(fixture("og-only.html").replaceAll("https://", "http://"));
  for (let i = 1; i <= 5; i++) server.routes.set(`northfield.example/boots-${i}`, page);
  server.routes.set("cdn.northfield.example/img/chelsea-tan-1.jpg?w=2000", bytes((await phoneJpeg({ width: 1800, height: 2000 })).data, "image/jpeg"));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  await server.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("several links at once", () => {
  it("step 2 with no cut-out tags the stored original and saves the item 'to review', keeping its link", async () => {
    const res = await addLink("http://northfield.example/boots-1");
    expect(res.status).toBe(200);
    const body = BatchAddResponseSchema.parse(await res.json());
    if (body.status !== "saved") throw new Error("expected saved");
    expect(body.item).toMatchObject({ source: "link", sourceUrl: "http://northfield.example/boots-1", needsReview: true, needsPhoto: false, cutoutUrl: null, tagsEdited: false });
    expect(fake.deps.fakeTagger.calls[0]!.image).not.toBeNull();
    expect(fake.deps.fakeTagger.calls[0]!.productHints).toMatchObject({ title: "Chelsea Boots in Tan Suede" });

    const review = ItemListResponseSchema.parse(await (await items.GET(new Request(`${BASE}/api/items?needsReview=true`))).json());
    expect(review.items.map((i) => i.id)).toEqual([body.item.id]);
  });

  it("a single add (no saveForReview) with no cut-out still returns a draft", async () => {
    const res1 = LinkImportResponseSchema.parse(await (await step1("http://northfield.example/boots-1")).json());
    if (res1.status !== "ok") throw new Error("expected ok");
    const draft = ItemDraftResponseSchema.parse(await (await step2({ originalImageKey: res1.originalImageKey })).json()).draft;
    expect(draft).toMatchObject({ cutoutImageKey: null, cutoutUrl: null, source: "link" });
    expect(fake.deps.items.rows.size).toBe(0);
  });

  it("when tagging fails twice the link comes back as a draft for the review list, not saved", async () => {
    fake.deps = makeLinkDeps(fake.deps.network, { taggerOutputs: ["not json"] });
    const body = BatchAddResponseSchema.parse(await (await addLink("http://northfield.example/boots-1")).json());
    expect(body.status).toBe("draft");
    if (body.status === "draft") expect(body.draft.suggestedTags).toBeNull();
    expect(fake.deps.items.rows.size).toBe(0);
  });

  it("replaying step 2 can't save the link twice", async () => {
    const res1 = LinkImportResponseSchema.parse(await (await step1("http://northfield.example/boots-1")).json());
    if (res1.status !== "ok") throw new Error("expected ok");
    expect((await step2({ originalImageKey: res1.originalImageKey, saveForReview: true })).status).toBe(200);
    const again = await step2({ originalImageKey: res1.originalImageKey, saveForReview: true });
    expect(ApiErrorSchema.parse(await again.json()).error.code).toBe("not_found");
    expect(fake.deps.items.rows.size).toBe(1);
  });

  it("a failed save gives the item count back and reopens the import, so the same link can be finished again", async () => {
    const res1 = LinkImportResponseSchema.parse(await (await step1("http://northfield.example/boots-1")).json());
    if (res1.status !== "ok") throw new Error("expected ok");
    vi.spyOn(fake.deps.items, "create").mockRejectedValueOnce(new Error("insert failed"));
    expect((await step2({ originalImageKey: res1.originalImageKey, saveForReview: true })).status).toBe(500);
    expect((await fake.deps.usage.summary(TEST_USER)).itemsToday.used).toBe(0);
    expect(fake.deps.items.rows.size).toBe(0);

    const retry = BatchAddResponseSchema.parse(await (await step2({ originalImageKey: res1.originalImageKey, saveForReview: true })).json());
    expect(retry.status).toBe("saved");
    expect((await fake.deps.usage.summary(TEST_USER)).itemsToday.used).toBe(1);
  });

  it("caps: the batch stops at the daily item cap, and the link that hits it fetches nothing", async () => {
    const limit = TEST_LIMITS.dailyCaps.item_ingest; // 3
    const statuses: number[] = [];
    for (let i = 1; i <= 5; i++) {
      const res = await addLink(`http://northfield.example/boots-${i}`);
      statuses.push(res.status);
      if (res.status !== 200) {
        const error = ApiErrorSchema.parse(await res.json()).error;
        expect(error.code).toBe("daily_cap_reached");
        expect(error.cap?.kind).toBe("items_per_day");
        break; // the phone stops here
      }
    }
    expect(statuses).toEqual([...Array(limit).fill(200), 429]);
    expect(fake.deps.items.rows.size).toBe(limit);
    // Only the links that were added fetched their page: the refused one counted no link fetch.
    expect(server.requests.filter((r) => r.host === "northfield.example")).toHaveLength(limit);
    const summary = await fake.deps.usage.summary(TEST_USER);
    expect(summary.itemsToday.used).toBe(limit);
  });
});
