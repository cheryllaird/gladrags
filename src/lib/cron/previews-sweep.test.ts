/** Round 2: the daily cleanup sweeps unused outfit previews and removes their images. */
import { describe, expect, it, vi } from "vitest";
import { PREVIEW_UNUSED_SWEEP_SECONDS, STORAGE_BUCKETS } from "@/contracts";
import { InMemorySignInAttemptStore } from "@/lib/auth/rate-limit";
import { InMemoryItemRepository } from "@/lib/ingestion/items-repository";
import { InMemoryImageStorage } from "@/lib/ingestion/storage";
import { InMemoryLinkImportRepository } from "@/lib/link-import/repository";
import { runDailyCleanup } from "./cleanup";
import { InMemoryUnusedPreviewSweeper } from "./previews";

const USER = "8a000000-0000-4000-8000-00000000008a";
const swept = `${USER}/00000000-0000-4000-8000-0000000000f1.webp`;
const kept = `${USER}/00000000-0000-4000-8000-0000000000f2.webp`;

describe("runDailyCleanup with previews", () => {
  it("sweeps unused previews older than an hour and removes their images", async () => {
    const clock = () => new Date("2026-11-14T03:17:00Z");
    const storage = new InMemoryImageStorage(clock);
    const image = { data: new Uint8Array([1, 2, 3]), mimeType: "image/png" as const };
    await storage.upload(STORAGE_BUCKETS.previews, swept, image);
    await storage.upload(STORAGE_BUCKETS.previews, kept, image);
    const references = new InMemoryItemRepository(clock);
    references.previews.set(kept, { userId: USER, itemIds: [] });
    const sweeper = new InMemoryUnusedPreviewSweeper({ deleted: 2, imageKeys: [swept] });

    const result = await runDailyCleanup({
      storage,
      references,
      linkImports: new InMemoryLinkImportRepository(clock),
      signInAttempts: new InMemorySignInAttemptStore(clock),
      previews: sweeper,
      now: clock,
    });

    expect(sweeper.calls).toEqual([PREVIEW_UNUSED_SWEEP_SECONDS]);
    expect(result.unusedPreviewsDeleted).toBe(2);
    expect(await storage.exists(STORAGE_BUCKETS.previews, swept)).toBe(false);
    expect(await storage.exists(STORAGE_BUCKETS.previews, kept)).toBe(true);
  });

  it("carries on with the other cleanups when the preview sweep fails", async () => {
    const clock = () => new Date("2026-11-14T03:17:00Z");
    const signInAttempts = new InMemorySignInAttemptStore(clock);
    const deleteOld = vi.spyOn(signInAttempts, "deleteCreatedBefore");
    const linkImports = new InMemoryLinkImportRepository(clock);
    const deleteImports = vi.spyOn(linkImports, "deleteCreatedBefore");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = { sweep: () => Promise.reject(new Error("connection reset")) };

    const result = await runDailyCleanup({
      storage: new InMemoryImageStorage(clock),
      references: new InMemoryItemRepository(clock),
      linkImports,
      signInAttempts,
      previews: failing,
      now: clock,
    });

    expect(result.unusedPreviewsDeleted).toBe(0);
    expect(deleteImports).toHaveBeenCalled();
    expect(deleteOld).toHaveBeenCalled();
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("preview sweep failed"), { error: "connection reset" });
    logged.mockRestore();
  });

  it("carries on when removing the swept images fails", async () => {
    const clock = () => new Date("2026-11-14T03:17:00Z");
    const storage = new InMemoryImageStorage(clock);
    vi.spyOn(storage, "remove").mockRejectedValueOnce(new Error("storage down"));
    const signInAttempts = new InMemorySignInAttemptStore(clock);
    const deleteOld = vi.spyOn(signInAttempts, "deleteCreatedBefore");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await runDailyCleanup({
      storage,
      references: new InMemoryItemRepository(clock),
      linkImports: new InMemoryLinkImportRepository(clock),
      signInAttempts,
      previews: new InMemoryUnusedPreviewSweeper({ deleted: 1, imageKeys: [swept] }),
      now: clock,
    });

    expect(result.unusedPreviewsDeleted).toBe(1);
    expect(deleteOld).toHaveBeenCalled();
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("couldn't remove unused preview images"), { images: 1 });
    logged.mockRestore();
  });
});
