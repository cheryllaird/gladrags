// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import type { ItemDraft } from "@/contracts";
import { MOCK_SUGGESTED_TAGS } from "@/lib/mocks/fixtures";
import { keepDraft, notePhotoLost, takePendingAdd } from "./pending-add";

const USER = "0a000000-0000-4000-8000-000000000001";
const DRAFT: ItemDraft = {
  source: "photo",
  sourceUrl: null,
  originalImageKey: `${USER}/1b000000-0000-4000-8000-000000000001.jpg`,
  cutoutImageKey: `${USER}/1b000000-0000-4000-8000-000000000002.png`,
  originalUrl: "/mock/items/uploaded.svg",
  cutoutUrl: "/mock/items/uploaded.svg",
  suggestedTags: MOCK_SUGGESTED_TAGS,
};

afterEach(() => window.sessionStorage.clear());

describe("pending add (kept across an expired session)", () => {
  it("keeps the draft with the tags as the user left them, once", () => {
    const tags = { ...MOCK_SUGGESTED_TAGS, description: "My edited shirt" };
    keepDraft(DRAFT, true, tags);
    expect(takePendingAdd()).toEqual({ kind: "draft", draft: DRAFT, cutoutFailed: true, tags });
    expect(takePendingAdd()).toBeNull();
  });

  it("remembers that a photo was lost", () => {
    notePhotoLost();
    expect(takePendingAdd()).toEqual({ kind: "photo_lost" });
  });

  it("ignores anything in storage that doesn't match the contracts", () => {
    window.sessionStorage.setItem("gladrags:pending-add", JSON.stringify({ kind: "draft", draft: { originalImageKey: "../../etc" } }));
    expect(takePendingAdd()).toBeNull();
    window.sessionStorage.setItem("gladrags:pending-add", "{not json");
    expect(takePendingAdd()).toBeNull();
  });

  it("is empty when nothing was kept", () => {
    expect(takePendingAdd()).toBeNull();
  });
});
