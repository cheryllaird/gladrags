/**
 * The add-by-link journey through the real route handlers, mock mode OFF:
 * paste a link (step 1) -> upload the cut-out (step 2) -> draft with tags
 * -> save -> the item keeps its link. Shops are a local test server behind
 * a fake DNS; Supabase and Gemini are in-memory fakes. No real network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiErrorSchema, ItemDraftResponseSchema, ItemResponseSchema, LinkImportResponseSchema } from "@/contracts";
import { tagging } from "@/test/fixtures/model-output";
import { TEST_USER } from "@/test/ingestion-deps";
import { asFile, cutoutPng, phoneJpeg } from "@/test/images";
import { PUBLIC_V4, bytes, fixture, html, makeLinkDeps, startTestServer, testNetwork, type TestServer } from "@/lib/link-import/test-support";

const fake = vi.hoisted(() => ({
  user: null as { id: string; email: string } | null,
  deps: null as unknown as ReturnType<typeof import("@/lib/link-import/test-support").makeLinkDeps>,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: fake.user } }) } }),
}));
vi.mock("@/lib/link-import/deps", () => ({
  getLinkImportDeps: () => fake.deps,
  getLinkCutoutDeps: () => fake.deps,
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

function json(path: string, body: unknown): Request {
  return new Request(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

async function cutoutRequest(meta: unknown, withCutout = true): Promise<Request> {
  const form = new FormData();
  form.set("meta", JSON.stringify(meta));
  if (withCutout) form.set("cutout", asFile(await cutoutPng({ width: 600, height: 800 }), "cutout.png"));
  return new Request(`${BASE}/api/items/link/cutout`, { method: "POST", body: form });
}

beforeEach(async () => {
  vi.stubEnv("GLADRAGS_MOCK_MODE", "false");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://qa-project.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_qa");
  server = await startTestServer();
  fake.user = { id: TEST_USER, email: "tester@example.com" };
  fake.deps = makeLinkDeps(testNetwork(server.port, { "northfield.example": [PUBLIC_V4], "cdn.northfield.example": [PUBLIC_V4] }), {
    taggerOutputs: [JSON.stringify(tagging.valid)],
  });
  server.routes.set("northfield.example/boots", html(fixture("og-only.html").replaceAll("https://", "http://")));
  server.routes.set("cdn.northfield.example/img/chelsea-tan-1.jpg?w=2000", bytes((await phoneJpeg({ width: 1800, height: 2000 })).data, "image/jpeg"));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  await server.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("add by link, mock mode off", () => {
  it("step 1 -> step 2 -> draft -> saved item that keeps its link", async () => {
    const url = "http://northfield.example/boots";
    const res1 = await link.POST(json("/api/items/link", { url }));
    expect(res1.status).toBe(200);
    const step1 = LinkImportResponseSchema.parse(await res1.json());
    if (step1.status !== "ok") throw new Error(`expected ok, got ${step1.reason}`);
    expect(step1.product).toEqual({ title: "Chelsea Boots in Tan Suede", brand: "Northfield", colour: "Tan" });

    // The phone sends back extra fields; only the key is used.
    const res2 = await linkCutout.POST(
      await cutoutRequest({ originalImageKey: step1.originalImageKey, sourceUrl: "https://evil.example/", product: { title: "x" } }),
    );
    expect(res2.status).toBe(200);
    const { draft } = ItemDraftResponseSchema.parse(await res2.json());
    expect(draft).toMatchObject({ source: "link", sourceUrl: url, originalImageKey: step1.originalImageKey, suggestedTags: tagging.valid });
    expect(fake.deps.fakeTagger.calls[0]!.productHints).toEqual(step1.product);

    const res3 = await items.POST(
      json("/api/items", {
        source: draft.source,
        sourceUrl: draft.sourceUrl,
        originalImageKey: draft.originalImageKey,
        cutoutImageKey: draft.cutoutImageKey,
        tags: draft.suggestedTags,
        tagsEdited: false,
      }),
    );
    expect(res3.status).toBe(201);
    const { item } = ItemResponseSchema.parse(await res3.json());
    expect(item).toMatchObject({ source: "link", sourceUrl: url });

    // Replaying step 2 is a 404.
    const replay = await linkCutout.POST(await cutoutRequest({ originalImageKey: step1.originalImageKey }));
    expect(replay.status).toBe(404);
  });

  it("a private-network link gets the screenshot fallback, with no request made", async () => {
    const res = await link.POST(json("/api/items/link", { url: "http://169.254.169.254/latest/meta-data/" }));
    expect(res.status).toBe(200);
    expect(LinkImportResponseSchema.parse(await res.json())).toMatchObject({ status: "needs_screenshot", reason: "fetch_blocked" });
    expect(server.requests).toEqual([]);
  });

  it("a bad cut-out is a 400 on the field and the import still works afterwards", async () => {
    const step1 = LinkImportResponseSchema.parse(await (await link.POST(json("/api/items/link", { url: "http://northfield.example/boots" }))).json());
    if (step1.status !== "ok") throw new Error("expected ok");
    const form = new FormData();
    form.set("meta", JSON.stringify({ originalImageKey: step1.originalImageKey }));
    form.set("cutout", asFile(await cutoutPng({ width: 1700, height: 1700 }), "big.png"));
    const bad = await linkCutout.POST(new Request(`${BASE}/api/items/link/cutout`, { method: "POST", body: form }));
    expect(bad.status).toBe(400);
    expect(ApiErrorSchema.parse(await bad.json()).error.issues?.[0]?.path).toBe("cutout");

    const ok = await linkCutout.POST(await cutoutRequest({ originalImageKey: step1.originalImageKey }, false));
    expect(ok.status).toBe(200);
  });

  it("mock markers do nothing outside mock mode", async () => {
    const res = await link.POST(json("/api/items/link", { url: "http://blocked-mock-ai-paused.example/" }));
    // A real (failed) fetch, not the mock's 503.
    expect(res.status).toBe(200);
    expect(LinkImportResponseSchema.parse(await res.json())).toMatchObject({ status: "needs_screenshot", reason: "fetch_blocked" });
  });
});
