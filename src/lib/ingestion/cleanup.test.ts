/**
 * Orphaned-image cleanup: unsaved drafts' images go once they're a day old;
 * saved items' images, recent drafts and open add-by-link imports stay.
 */
import { describe, expect, it } from "vitest";
import { STORAGE_BUCKETS } from "@/contracts";
import { OTHER_USER, TEST_USER, makeTestDeps } from "@/test/ingestion-deps";
import { tagging } from "@/test/fixtures/model-output";
import { cutoutPng, phoneJpeg } from "@/test/images";
import { cleanUpOrphanedImages } from "./cleanup";
import { newImageKey } from "./storage";

async function setup() {
  const deps = makeTestDeps();
  const put = async (bucket: "originals" | "cutouts", userId: string) => {
    const key = newImageKey(userId, bucket === "originals" ? "image/jpeg" : "image/png");
    await deps.storage.upload(bucket, key, bucket === "originals" ? await phoneJpeg() : await cutoutPng());
    return key;
  };

  // Two days ago: one saved item, one abandoned draft per user, one open link import.
  deps.setNow("2026-10-23T09:00:00Z");
  const savedOriginal = await put("originals", TEST_USER);
  const savedCutout = await put("cutouts", TEST_USER);
  await deps.items.create(TEST_USER, {
    source: "photo",
    sourceUrl: null,
    originalImageKey: savedOriginal,
    cutoutImageKey: savedCutout,
    tags: tagging.valid as never,
    tagsEdited: false,
  });
  const abandonedOriginal = await put("originals", TEST_USER);
  const abandonedCutout = await put("cutouts", TEST_USER);
  const othersAbandoned = await put("originals", OTHER_USER);
  const linkImport = await put("originals", OTHER_USER);
  deps.items.openLinkImportKeys.add(linkImport);

  // An hour ago: a draft the user may still be reviewing.
  deps.setNow("2026-10-25T09:00:00Z");
  const recentDraft = await put("originals", TEST_USER);

  deps.setNow("2026-10-25T10:00:00Z");
  return {
    deps,
    cleanupDeps: { storage: deps.storage, references: deps.items, now: () => new Date("2026-10-25T10:00:00Z") },
    keys: { savedOriginal, savedCutout, abandonedOriginal, abandonedCutout, othersAbandoned, linkImport, recentDraft },
  };
}

describe("cleanUpOrphanedImages", () => {
  it("deletes old unsaved images in every user's folder and keeps everything still needed", async () => {
    const { deps, cleanupDeps, keys } = await setup();
    const report = await cleanUpOrphanedImages(cleanupDeps);

    expect(report.deleted).toEqual(
      expect.arrayContaining([
        { bucket: "originals", key: keys.abandonedOriginal },
        { bucket: "originals", key: keys.othersAbandoned },
        { bucket: "cutouts", key: keys.abandonedCutout },
      ]),
    );
    expect(report.deleted).toHaveLength(3);
    for (const key of [keys.abandonedOriginal, keys.othersAbandoned]) {
      expect(await deps.storage.exists(STORAGE_BUCKETS.originals, key)).toBe(false);
    }
    expect(await deps.storage.exists(STORAGE_BUCKETS.cutouts, keys.abandonedCutout)).toBe(false);
    for (const key of [keys.savedOriginal, keys.linkImport, keys.recentDraft]) {
      expect(await deps.storage.exists(STORAGE_BUCKETS.originals, key)).toBe(true);
    }
    expect(await deps.storage.exists(STORAGE_BUCKETS.cutouts, keys.savedCutout)).toBe(true);
  });

  it("only reports in a dry run", async () => {
    const { deps, cleanupDeps, keys } = await setup();
    const report = await cleanUpOrphanedImages(cleanupDeps, { dryRun: true });
    expect(report.deleted).toHaveLength(3);
    expect(await deps.storage.exists(STORAGE_BUCKETS.originals, keys.abandonedOriginal)).toBe(true);
  });

  it("respects a shorter minimum age", async () => {
    const { cleanupDeps, keys } = await setup();
    const report = await cleanUpOrphanedImages(cleanupDeps, { minAgeMs: 30 * 60 * 1000 });
    expect(report.deleted.map((d) => d.key)).toContain(keys.recentDraft);
  });
});
