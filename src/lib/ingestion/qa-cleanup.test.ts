/**
 * QA gap tests for the orphaned-image cleanup: never delete an image an
 * item uses, one inside the 24 h window, or one an add-by-link import can
 * still claim; a dry run deletes nothing; a failed lookup stops it.
 */
import { describe, expect, it, vi } from "vitest";
import { STORAGE_BUCKETS } from "@/contracts";
import { cutoutPng, phoneJpeg } from "@/test/images";
import { OTHER_USER, TEST_USER, makeTestDeps } from "@/test/ingestion-deps";
import { tagging } from "@/test/fixtures/model-output";
import { ORPHAN_MIN_AGE_MS, cleanUpOrphanedImages } from "./cleanup";
import { newImageKey } from "./storage";

const NOW = new Date("2026-10-25T10:00:00Z");

async function put(deps: ReturnType<typeof makeTestDeps>, bucket: "originals" | "cutouts", userId: string, at: Date) {
  deps.setNow(at.toISOString());
  const key = newImageKey(userId, bucket === "originals" ? "image/jpeg" : "image/png");
  await deps.storage.upload(bucket, key, bucket === "originals" ? await phoneJpeg() : await cutoutPng());
  return key;
}

const ago = (ms: number) => new Date(NOW.getTime() - ms);
const run = (deps: ReturnType<typeof makeTestDeps>, options = {}) =>
  cleanUpOrphanedImages({ storage: deps.storage, references: deps.items, now: () => NOW }, options);

describe("cleanUpOrphanedImages: what it must never delete", () => {
  it("the 24 h window is exclusive: an orphan exactly 24 h old stays, one a millisecond older goes", async () => {
    const deps = makeTestDeps();
    const exactly = await put(deps, "originals", TEST_USER, ago(ORPHAN_MIN_AGE_MS));
    const older = await put(deps, "originals", TEST_USER, ago(ORPHAN_MIN_AGE_MS + 1));
    const report = await run(deps);
    expect(report.deleted.map((d) => d.key)).toEqual([older]);
    expect(await deps.storage.exists(STORAGE_BUCKETS.originals, exactly)).toBe(true);
  });

  it("an image used by an item is kept however old, in either bucket, for any user", async () => {
    const deps = makeTestDeps();
    const year = 365 * 24 * 60 * 60 * 1000;
    for (const user of [TEST_USER, OTHER_USER]) {
      const originalImageKey = await put(deps, "originals", user, ago(year));
      const cutoutImageKey = await put(deps, "cutouts", user, ago(year));
      await deps.items.create(user, {
        source: "photo",
        sourceUrl: null,
        originalImageKey,
        cutoutImageKey,
        tags: tagging.valid as never,
        tagsEdited: false,
      });
    }
    const report = await run(deps, { minAgeMs: 0 });
    expect(report.deleted).toEqual([]);
    expect(report.checked).toBe(4);
    expect(deps.storage.objects.size).toBe(4);
  });

  it("a claimable add-by-link import's image is kept even with a tiny minimum age", async () => {
    const deps = makeTestDeps();
    const importKey = await put(deps, "originals", TEST_USER, ago(30 * 60 * 1000));
    deps.items.openLinkImportKeys.add(importKey);
    const report = await run(deps, { minAgeMs: 0 });
    expect(report.deleted).toEqual([]);
  });

  it("a key shared between buckets is judged per bucket: an orphaned cut-out goes even if an item uses its original", async () => {
    const deps = makeTestDeps();
    const originalImageKey = await put(deps, "originals", TEST_USER, ago(2 * ORPHAN_MIN_AGE_MS));
    const orphanCutout = await put(deps, "cutouts", TEST_USER, ago(2 * ORPHAN_MIN_AGE_MS));
    await deps.items.create(TEST_USER, {
      source: "photo",
      sourceUrl: null,
      originalImageKey,
      cutoutImageKey: null,
      tags: tagging.valid as never,
      tagsEdited: false,
    });
    const report = await run(deps);
    expect(report.deleted).toEqual([{ bucket: STORAGE_BUCKETS.cutouts, key: orphanCutout }]);
  });
});

describe("cleanUpOrphanedImages: dry run and failures", () => {
  it("a dry run reports every orphan, in both buckets, and removes nothing", async () => {
    const deps = makeTestDeps();
    await put(deps, "originals", TEST_USER, ago(2 * ORPHAN_MIN_AGE_MS));
    await put(deps, "cutouts", OTHER_USER, ago(2 * ORPHAN_MIN_AGE_MS));
    const remove = vi.spyOn(deps.storage, "remove");
    const report = await run(deps, { dryRun: true });
    expect(report.deleted).toHaveLength(2);
    expect(remove).not.toHaveBeenCalled();
    expect(deps.storage.objects.size).toBe(2);
  });

  it("if the reference lookup fails, it stops without deleting anything", async () => {
    const deps = makeTestDeps();
    await put(deps, "originals", TEST_USER, ago(2 * ORPHAN_MIN_AGE_MS));
    vi.spyOn(deps.items, "referenced").mockRejectedValue(new Error("db down"));
    const remove = vi.spyOn(deps.storage, "remove");
    await expect(run(deps)).rejects.toThrow("db down");
    expect(remove).not.toHaveBeenCalled();
    expect(deps.storage.objects.size).toBe(1);
  });

  it("works in batches: 120 orphans in one folder are all checked and removed", async () => {
    const deps = makeTestDeps();
    for (let i = 0; i < 120; i++) await put(deps, "originals", TEST_USER, ago(2 * ORPHAN_MIN_AGE_MS));
    const lookups = vi.spyOn(deps.items, "referenced");
    const report = await run(deps);
    expect(report.deleted).toHaveLength(120);
    expect(lookups.mock.calls.every(([keys]) => keys.length <= 50)).toBe(true);
    expect(deps.storage.objects.size).toBe(0);
  });
});
