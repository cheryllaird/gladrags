/**
 * QA (fix/hardening): the link_fetch cap in step 1 under parallel requests,
 * and the item count's refund in step 2 when the claim fails.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STORAGE_BUCKETS, type LinkProduct } from "@/contracts";
import { ApiException } from "@/lib/api/errors";
import type { LinkCutoutUpload } from "@/lib/api/upload";
import { CapReachedError } from "@/lib/usage/errors";
import { tagging } from "@/test/fixtures/model-output";
import { TEST_LIMITS, TEST_USER } from "@/test/ingestion-deps";
import { cutoutPng, phoneJpeg } from "@/test/images";
import { finishLinkImport } from "./finish-link";
import { importFromLink } from "./import-link";
import { makeLinkDeps, testNetwork } from "./test-support";

const SOURCE_URL = "https://shop.example/p/linen-shirt";
const PRODUCT: LinkProduct = { title: "Relaxed Linen Shirt", brand: "Hartley & Lowe", colour: "Navy/White" };
/** A private address: step 1 falls back to the screenshot without any network request. */
const PRIVATE_LINK = "http://169.254.169.254/latest/meta-data/";

let deps: ReturnType<typeof makeLinkDeps>;

async function stepOne(): Promise<string> {
  const key = `${TEST_USER}/${crypto.randomUUID()}.jpg`;
  const original = await deps.images.stripMetadata(await phoneJpeg({ width: 1200, height: 1600 }));
  await deps.storage.upload(STORAGE_BUCKETS.originals, key, original);
  await deps.linkImports.create({ userId: TEST_USER, sourceUrl: SOURCE_URL, originalImageKey: key, product: PRODUCT });
  return key;
}

async function upload(originalImageKey: string): Promise<LinkCutoutUpload> {
  const image = await cutoutPng({ width: 600, height: 900 });
  return { meta: { originalImageKey }, cutout: { data: image.data, mimeType: "image/png", name: "cutout.png" } };
}

const count = (kind: string) => deps.usageStore.events.filter((e) => e.kind === kind).length;
const cutouts = () => [...deps.storage.objects.keys()].filter((k) => k.startsWith("cutouts/"));

beforeEach(() => {
  deps = makeLinkDeps(testNetwork(1, {}), { taggerOutputs: [JSON.stringify(tagging.valid)] });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe("step 1: the link_fetch cap", () => {
  it(`${TEST_LIMITS.dailyCaps.link_fetch + 15} parallel fetches: exactly ${TEST_LIMITS.dailyCaps.link_fetch} run, the rest get link_fetches_per_day`, async () => {
    const n = TEST_LIMITS.dailyCaps.link_fetch + 15;
    const results = await Promise.allSettled(Array.from({ length: n }, () => importFromLink(deps, TEST_USER, PRIVATE_LINK)));
    const ok = results.filter((r) => r.status === "fulfilled");
    const refused = results.flatMap((r) => (r.status === "rejected" ? [r.reason as unknown] : []));
    expect(ok).toHaveLength(TEST_LIMITS.dailyCaps.link_fetch);
    expect(refused).toHaveLength(15);
    for (const error of refused) {
      expect(error).toBeInstanceOf(CapReachedError);
      expect((error as CapReachedError).cap).toBe("link_fetches_per_day");
    }
    expect(count("link_fetch")).toBe(TEST_LIMITS.dailyCaps.link_fetch);
  });

  it("fallbacks count (every attempt made the server work), and nothing counts against items", async () => {
    await importFromLink(deps, TEST_USER, PRIVATE_LINK);
    expect(count("link_fetch")).toBe(1);
    expect(count("item_ingest")).toBe(0);
  });

  it("at the item cap, step 1 is refused before a link fetch is counted", async () => {
    for (let i = 0; i < TEST_LIMITS.dailyCaps.item_ingest; i++) await deps.usage.reserveAction(TEST_USER, "item_ingest");
    await expect(importFromLink(deps, TEST_USER, PRIVATE_LINK)).rejects.toMatchObject({ cap: "items_per_day" });
    expect(count("link_fetch")).toBe(0);
  });

  it("with AI paused, step 1 is refused before a link fetch is counted", async () => {
    await deps.usage.recordAiCost(null, "tagging", TEST_LIMITS.monthlySpendCapPence);
    await expect(importFromLink(deps, TEST_USER, PRIVATE_LINK)).rejects.toMatchObject({ cap: "monthly_ai_spend" });
    expect(count("link_fetch")).toBe(0);
  });

  it("the cap resets at UK midnight (BST)", async () => {
    deps.setNow("2026-07-14T22:59:00Z");
    for (let i = 0; i < TEST_LIMITS.dailyCaps.link_fetch; i++) await importFromLink(deps, TEST_USER, PRIVATE_LINK);
    await expect(importFromLink(deps, TEST_USER, PRIVATE_LINK)).rejects.toBeInstanceOf(CapReachedError);
    deps.setNow("2026-07-14T23:00:00Z");
    await expect(importFromLink(deps, TEST_USER, PRIVATE_LINK)).resolves.toMatchObject({ status: "needs_screenshot" });
  });
});

describe("step 2: the item count is given back when the claim fails", () => {
  it("ten step 2s for one import at once: one draft, one count, no stray cut-outs", async () => {
    const key = await stepOne();
    const uploads = await Promise.all(Array.from({ length: 10 }, () => upload(key)));
    const results = await Promise.allSettled(uploads.map((u) => finishLinkImport(deps, TEST_USER, u)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) if (r.status === "rejected") expect((r.reason as ApiException).code).toBe("not_found");
    expect(count("item_ingest")).toBe(1);
    expect(cutouts()).toHaveLength(1);
  });

  it("a claim that throws (database error): the count and the cut-out are both given back", async () => {
    const key = await stepOne();
    vi.spyOn(deps.linkImports, "claim").mockRejectedValueOnce(new Error("Couldn't claim the link import: db down"));
    await expect(finishLinkImport(deps, TEST_USER, await upload(key))).rejects.toThrow(/db down/);
    expect(count("item_ingest")).toBe(0);
    expect(cutouts()).toEqual([]);
  });

  it("storing the cut-out fails: the count is given back", async () => {
    const key = await stepOne();
    vi.spyOn(deps.storage, "upload").mockRejectedValueOnce(new Error("storage down"));
    await expect(finishLinkImport(deps, TEST_USER, await upload(key))).rejects.toThrow(/storage down/);
    expect(count("item_ingest")).toBe(0);
    expect(await deps.linkImports.findOpen(TEST_USER, key)).not.toBeNull();
  });

  it("at the cap with one place left, a replayed (already used) import doesn't take the place from a real one", async () => {
    const used = await stepOne();
    await finishLinkImport(deps, TEST_USER, await upload(used));
    for (let i = count("item_ingest"); i < TEST_LIMITS.dailyCaps.item_ingest - 1; i++) await deps.usage.reserveAction(TEST_USER, "item_ingest");
    const fresh = await stepOne();
    const [replayUpload, freshUpload] = [await upload(used), await upload(fresh)];
    const [replay, real] = await Promise.allSettled([
      finishLinkImport(deps, TEST_USER, replayUpload),
      finishLinkImport(deps, TEST_USER, freshUpload),
    ]);
    expect(replay.status).toBe("rejected");
    expect(((replay as PromiseRejectedResult).reason as ApiException).code).toBe("not_found");
    expect(real.status).toBe("fulfilled");
    expect(count("item_ingest")).toBe(TEST_LIMITS.dailyCaps.item_ingest);
  });

  it("a claim lost in a race at the last place: refunded, so the place is free again", async () => {
    for (let i = 0; i < TEST_LIMITS.dailyCaps.item_ingest - 1; i++) await deps.usage.reserveAction(TEST_USER, "item_ingest");
    const key = await stepOne();
    vi.spyOn(deps.linkImports, "claim").mockResolvedValueOnce(null);
    await expect(finishLinkImport(deps, TEST_USER, await upload(key))).rejects.toMatchObject({ code: "not_found" });
    expect(count("item_ingest")).toBe(TEST_LIMITS.dailyCaps.item_ingest - 1);
    expect(cutouts()).toEqual([]);
    await expect(deps.usage.reserveAction(TEST_USER, "item_ingest")).resolves.toBeDefined();
  });

  // Was FINDING (low), fixed: a failed refund after a lost claim gave a 500
  // instead of the documented 404. The refund is now best effort there too.
  it("a lost claim whose refund fails still answers not_found", async () => {
    const key = await stepOne();
    // Another request claims the import between this one's lookup and its claim.
    vi.spyOn(deps.linkImports, "claim").mockResolvedValueOnce(null);
    vi.spyOn(deps.usageStore, "cancel").mockRejectedValueOnce(new Error("Couldn't cancel usage: db down"));
    const error = await finishLinkImport(deps, TEST_USER, await upload(key)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiException);
    expect((error as ApiException).code).toBe("not_found");
  });

  // Was FINDING (low), fixed: AI pausing between the item count and the
  // tagging call used to keep the count and use the import up. Now the
  // count is given back and the import reopened.
  it("ai_paused during tagging after the claim gives the count back and reopens the import", async () => {
    const key = await stepOne();
    const prepare = deps.images.prepareForModel.bind(deps.images);
    vi.spyOn(deps.images, "prepareForModel").mockImplementationOnce(async (...args) => {
      await deps.usage.recordAiCost(null, "tagging", TEST_LIMITS.monthlySpendCapPence);
      return prepare(...args);
    });
    await expect(finishLinkImport(deps, TEST_USER, await upload(key))).rejects.toMatchObject({ cap: "monthly_ai_spend" });
    expect(count("item_ingest")).toBe(0);
    expect(await deps.linkImports.findOpen(TEST_USER, key)).not.toBeNull();
    expect(cutouts()).toEqual([]);
  });
});
