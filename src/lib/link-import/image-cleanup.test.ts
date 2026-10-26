/**
 * Unfinished add-by-link imports and ingestion's orphaned-image cleanup
 * (src/lib/ingestion/cleanup.ts). Checks the two work together:
 * - an import that can still be finished keeps its image;
 * - a day later, an abandoned import's image (and an unsaved step-2
 *   cut-out) is deleted;
 * - images of an item that was saved are kept.
 *
 * The production ImageReferences (SupabaseImageReferences) counts an image
 * as needed while its link_imports row is inside LINK_IMPORT_TTL_SECONDS;
 * its query is tested in src/lib/ingestion/qa-supabase-repositories.test.ts.
 * Here the in-memory items repository stands in, fed with the imports that
 * are still open.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { STORAGE_BUCKETS } from "@/contracts";
import { ORPHAN_MIN_AGE_MS, cleanUpOrphanedImages } from "@/lib/ingestion/cleanup";
import type { ImageReferences } from "@/lib/ingestion/items-repository";
import { tagging } from "@/test/fixtures/model-output";
import { TEST_USER } from "@/test/ingestion-deps";
import { cutoutPng, phoneJpeg } from "@/test/images";
import { finishLinkImport } from "./finish-link";
import { importFromLink } from "./import-link";
import { PUBLIC_V4, bytes, html, makeLinkDeps, startTestServer, testNetwork, type TestServer } from "./test-support";

let server: TestServer;
let deps: ReturnType<typeof makeLinkDeps>;

beforeEach(async () => {
  server = await startTestServer();
  deps = makeLinkDeps(testNetwork(server.port, { "shop.example": [PUBLIC_V4] }), { taggerOutputs: [JSON.stringify(tagging.valid)] });
  server.routes.set("shop.example/p", html(`<meta property="og:type" content="product"><meta property="og:title" content="Shirt"><meta property="og:image" content="/i.jpg">`));
  server.routes.set("shop.example/i.jpg", bytes((await phoneJpeg({ width: 800, height: 1000 })).data, "image/jpeg"));
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  await server.close();
  vi.restoreAllMocks();
});

function references(): ImageReferences {
  return {
    referenced: async (keys) => {
      deps.items.openLinkImportKeys.clear();
      for (const key of deps.linkImports.openKeys()) deps.items.openLinkImportKeys.add(key);
      return deps.items.referenced(keys);
    },
  };
}

async function stepOne(): Promise<string> {
  const result = await importFromLink(deps, TEST_USER, "http://shop.example/p");
  if (result.status !== "ok") throw new Error(result.reason);
  return result.originalImageKey;
}

const cleanup = (minAgeMs = ORPHAN_MIN_AGE_MS) =>
  cleanUpOrphanedImages({ storage: deps.storage, references: references(), now: deps.clock }, { minAgeMs });

it("keeps an open import's image, even with no minimum age", async () => {
  const key = await stepOne();
  const report = await cleanup(0);
  expect(report.deleted).toEqual([]);
  expect(await deps.storage.exists(STORAGE_BUCKETS.originals, key)).toBe(true);
});

it("deletes an abandoned step-1 image, and an unsaved step-2 cut-out, once they're a day old", async () => {
  const abandoned = await stepOne();
  const finished = await stepOne();
  const cutout = await cutoutPng({ width: 400, height: 500 });
  const draft = await finishLinkImport(deps, TEST_USER, { meta: { originalImageKey: finished }, cutout: { ...cutout, name: "c.png" } });
  expect(draft.cutoutImageKey).not.toBeNull();

  deps.advance(ORPHAN_MIN_AGE_MS + 60_000);
  const report = await cleanup();
  expect(report.deleted.map((d) => d.key).sort()).toEqual([abandoned, finished, draft.cutoutImageKey!].sort());
  expect(deps.storage.objects.size).toBe(0);
});

it("keeps the images of an item that was saved from a link", async () => {
  const key = await stepOne();
  const cutout = await cutoutPng({ width: 400, height: 500 });
  const draft = await finishLinkImport(deps, TEST_USER, { meta: { originalImageKey: key }, cutout: { ...cutout, name: "c.png" } });
  await deps.items.create(TEST_USER, {
    source: "link",
    sourceUrl: draft.sourceUrl,
    originalImageKey: draft.originalImageKey,
    cutoutImageKey: draft.cutoutImageKey,
    tags: tagging.valid,
    tagsEdited: false,
  } as Parameters<typeof deps.items.create>[1]);

  deps.advance(ORPHAN_MIN_AGE_MS + 60_000);
  const report = await cleanup();
  expect(report.deleted).toEqual([]);
  expect(await deps.storage.exists(STORAGE_BUCKETS.originals, key)).toBe(true);
  expect(await deps.storage.exists(STORAGE_BUCKETS.cutouts, draft.cutoutImageKey!)).toBe(true);
});
