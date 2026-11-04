// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ItemDraft } from "@/contracts";
import { BATCH_DRAFTS_KEY, BATCH_DRAFT_MAX_AGE_MS, keepBatchDraft, readBatchDrafts, removeBatchDraft } from "./batch-drafts";

const USER = "0a000000-0000-4000-8000-000000000001";
const OTHER = "0a000000-0000-4000-8000-000000000002";
const draft = (user: string, n: number): ItemDraft => ({
  source: "photo",
  sourceUrl: null,
  originalImageKey: `${user}/1b000000-0000-4000-8000-00000000000${n}.jpg`,
  cutoutImageKey: null,
  originalUrl: "/mock/items/uploaded.svg",
  cutoutUrl: null,
  suggestedTags: null,
});

afterEach(() => window.sessionStorage.clear());

describe("batch drafts", () => {
  it("keeps, lists and removes the user's drafts, without duplicates", () => {
    keepBatchDraft(USER, draft(USER, 1));
    keepBatchDraft(USER, draft(USER, 2));
    keepBatchDraft(USER, draft(USER, 1));
    expect(readBatchDrafts(USER).map((d) => d.originalImageKey)).toEqual([draft(USER, 2).originalImageKey, draft(USER, 1).originalImageKey]);
    removeBatchDraft(USER, draft(USER, 2).originalImageKey);
    expect(readBatchDrafts(USER)).toHaveLength(1);
    removeBatchDraft(USER, draft(USER, 1).originalImageKey);
    expect(window.sessionStorage.getItem(BATCH_DRAFTS_KEY)).toBeNull();
  });

  it("never hands one user's drafts to another, or keeps a draft with someone else's images", () => {
    keepBatchDraft(USER, draft(USER, 1));
    expect(readBatchDrafts(OTHER)).toEqual([]);
    keepBatchDraft(USER, draft(OTHER, 2));
    expect(readBatchDrafts(USER)).toHaveLength(1);
    keepBatchDraft(null, draft(USER, 3));
    expect(readBatchDrafts(null)).toEqual([]);
  });

  it("drops drafts before their one-hour signed picture URL expires", () => {
    expect(BATCH_DRAFT_MAX_AGE_MS).toBe(55 * 60 * 1000);
    expect(BATCH_DRAFT_MAX_AGE_MS).toBeLessThan(60 * 60 * 1000);
    keepBatchDraft(USER, draft(USER, 1), 0);
    expect(readBatchDrafts(USER, 54 * 60 * 1000)).toHaveLength(1);
    expect(readBatchDrafts(USER, 56 * 60 * 1000)).toEqual([]);
  });

  it("says whether the draft was kept", () => {
    expect(keepBatchDraft(USER, draft(USER, 1))).toBe(true);
    expect(keepBatchDraft(null, draft(USER, 2))).toBe(false);
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("full");
    });
    expect(keepBatchDraft(USER, draft(USER, 3))).toBe(false);
    setItem.mockRestore();
  });

  it("reads tampered storage as no drafts", () => {
    window.sessionStorage.setItem(BATCH_DRAFTS_KEY, JSON.stringify({ userId: USER, drafts: [{ draft: "x", addedAt: 0 }] }));
    expect(readBatchDrafts(USER)).toEqual([]);
    window.sessionStorage.setItem(BATCH_DRAFTS_KEY, "{");
    expect(readBatchDrafts(USER)).toEqual([]);
  });
});
