import { describe, expect, it } from "vitest";
import { MOCK_ITEMS } from "@/lib/mocks/fixtures";
import { ApiClientError } from "@/lib/client/api";
import type { BatchEntryState } from "@/lib/client/add-item";
import { batchEntryLabel, batchSummaryCopy } from "./batch-copy";

const saved: BatchEntryState = { kind: "saved", item: { ...MOCK_ITEMS[0]!, needsReview: true } };
const notAdded: BatchEntryState = { kind: "not_added" };
const cap = new ApiClientError("daily_cap_reached", "x", {
  status: 429,
  cap: { kind: "items_per_day", limit: 40, resetsAt: "2099-01-01T00:00:00.000Z" },
});

describe("batchSummaryCopy", () => {
  it("all added", () => {
    const copy = batchSummaryCopy("photo", [saved, saved], null);
    expect(copy.title).toBe("All 2 photos added");
    expect(copy.lines).toEqual(["2 items are in your wardrobe, marked to review."]);
    expect(copy.stopped).toBeNull();
  });

  it("stopped at the daily cap says how many were added and how many weren't", () => {
    const copy = batchSummaryCopy("photo", [saved, saved, saved, notAdded, notAdded], cap);
    expect(copy.title).toBe("That's today's limit");
    expect(copy.stopped).toBe("cap");
    expect(copy.lines[0]).toBe("3 were added before it stopped; the other 2 photos weren't.");
    expect(copy.lines[1]).toContain("You've added 40 items today.");
  });

  it("drafts, screenshots and failures each get a line", () => {
    const copy = batchSummaryCopy(
      "link",
      [
        saved,
        { kind: "draft", draft: { source: "link", sourceUrl: "https://a.example/p", originalImageKey: "k", cutoutImageKey: null, originalUrl: "/x", cutoutUrl: null, suggestedTags: null } },
        { kind: "needs_screenshot", sourceUrl: "https://blocked.example/p", message: "m" },
        { kind: "failed", error: new Error("x") },
      ],
      null,
    );
    expect(copy.title).toBe("Done");
    expect(copy.lines).toEqual([
      "1 item is in your wardrobe, marked to review.",
      "1 couldn't be tagged automatically: fill in the tags in the review list.",
      "1 link needs a screenshot: the site couldn't be read. Add them below.",
      "1 couldn't be added (see below).",
    ]);
  });
});

describe("batchEntryLabel", () => {
  it("says where each one is", () => {
    expect(batchEntryLabel({ kind: "pending", stage: "waiting" })).toBe("Waiting");
    expect(batchEntryLabel({ kind: "pending", stage: "uploading" })).toBe("Tagging…");
    expect(batchEntryLabel(saved)).toBe(`Added: ${MOCK_ITEMS[0]!.tags.description}`);
    expect(batchEntryLabel(notAdded)).toBe("Not added");
  });
});

describe("batchSummaryCopy, one left over", () => {
  it("says 'the other 1 photo wasn't'", () => {
    expect(batchSummaryCopy("photo", [saved, notAdded], cap).lines[0]).toBe("1 was added before it stopped; the other 1 photo wasn't.");
  });
});
