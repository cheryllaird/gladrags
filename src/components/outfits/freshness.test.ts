import { afterEach, describe, expect, it, vi } from "vitest";
import type { Outfit } from "@/contracts";
import { outfitsApi } from "./api";
import { REFETCH_AFTER_MS, isStale, refetchOutfits } from "./freshness";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isStale", () => {
  it("refetches before the one-hour signed URLs expire", () => {
    expect(REFETCH_AFTER_MS).toBeLessThan(60 * 60 * 1000);
    expect(isStale(0, REFETCH_AFTER_MS - 1)).toBe(false);
    expect(isStale(0, REFETCH_AFTER_MS)).toBe(true);
  });
});

describe("refetchOutfits", () => {
  const outfit = (id: string, name: string) => ({ id, name }) as unknown as Outfit;

  it("swaps in fresh copies, and keeps any that can't be fetched", async () => {
    vi.spyOn(outfitsApi, "getOutfit").mockImplementation(async (id: string) =>
      id === "a"
        ? { ok: true, data: { outfit: outfit("a", "fresh") } }
        : { ok: false, error: { code: "not_found", message: "Gone" } },
    );
    const result = await refetchOutfits([outfit("a", "old"), outfit("b", "old")]);
    expect(result.map((o) => o.name)).toEqual(["fresh", "old"]);
  });
});
