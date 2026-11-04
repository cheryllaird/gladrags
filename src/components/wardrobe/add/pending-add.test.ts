// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import type { ItemDraft } from "@/contracts";
import { MOCK_SUGGESTED_TAGS } from "@/lib/mocks/fixtures";
import { keepDraft, notePhotoLost, takePendingAdd } from "./pending-add";

const USER = "0a000000-0000-4000-8000-000000000001";
const OTHER_USER = "0a000000-0000-4000-8000-000000000002";
const KEY = "gladrags:pending-add";

function draftFor(userId: string): ItemDraft {
  return {
    source: "photo",
    sourceUrl: null,
    originalImageKey: `${userId}/1b000000-0000-4000-8000-000000000001.jpg`,
    cutoutImageKey: `${userId}/1b000000-0000-4000-8000-000000000002.png`,
    originalUrl: "/mock/items/uploaded.svg",
    cutoutUrl: "/mock/items/uploaded.svg",
    suggestedTags: MOCK_SUGGESTED_TAGS,
  };
}
const DRAFT = draftFor(USER);

/** Write a kept draft straight into storage, as a stale tab or tampering could leave it. */
function plant(value: unknown) {
  window.sessionStorage.setItem(KEY, JSON.stringify(value));
}

afterEach(() => window.sessionStorage.clear());

describe("pending add (kept across an expired session)", () => {
  it("keeps the draft with the tags as the user left them, once", () => {
    const tags = { ...MOCK_SUGGESTED_TAGS, description: "My edited shirt" };
    keepDraft(USER, DRAFT, tags);
    expect(takePendingAdd(USER)).toEqual({ kind: "draft", draft: DRAFT, tags });
    expect(takePendingAdd(USER)).toBeNull();
  });

  it("stores whose draft it is", () => {
    keepDraft(USER, DRAFT, null);
    expect(JSON.parse(window.sessionStorage.getItem(KEY)!)).toMatchObject({ kind: "draft", userId: USER });
  });

  it("remembers that a photo was lost", () => {
    notePhotoLost(USER);
    expect(takePendingAdd(USER)).toEqual({ kind: "photo_lost" });
  });

  it("ignores anything in storage that doesn't match the contracts", () => {
    plant({ kind: "draft", userId: USER, draft: { originalImageKey: "../../etc" } });
    expect(takePendingAdd(USER)).toBeNull();
    window.sessionStorage.setItem(KEY, "{not json");
    expect(takePendingAdd(USER)).toBeNull();
  });

  it("is empty when nothing was kept", () => {
    expect(takePendingAdd(USER)).toBeNull();
  });
});

describe("pending add when someone else signs in on the same tab", () => {
  it("doesn't show one user's draft to another, and deletes it", () => {
    keepDraft(USER, DRAFT, { ...MOCK_SUGGESTED_TAGS, description: "First user's shirt" });
    expect(takePendingAdd(OTHER_USER)).toBeNull();
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
    // Gone for the first user too: it isn't kept around waiting for them.
    expect(takePendingAdd(USER)).toBeNull();
  });

  it("doesn't pass on another user's lost-photo note", () => {
    notePhotoLost(USER);
    expect(takePendingAdd(OTHER_USER)).toBeNull();
  });

  it("drops a draft whose original image is in someone else's folder, even if the user ID matches", () => {
    plant({ kind: "draft", userId: OTHER_USER, draft: DRAFT, tags: null });
    expect(takePendingAdd(OTHER_USER)).toBeNull();
  });

  it("drops a draft whose cut-out is in someone else's folder", () => {
    const mixed = { ...DRAFT, cutoutImageKey: `${OTHER_USER}/1b000000-0000-4000-8000-000000000002.png` };
    plant({ kind: "draft", userId: USER, draft: mixed, tags: null });
    expect(takePendingAdd(USER)).toBeNull();
  });

  it("restores a draft with no cut-out when the original is the user's", () => {
    const noCutout = { ...DRAFT, cutoutImageKey: null, cutoutUrl: null };
    keepDraft(USER, noCutout, null);
    expect(takePendingAdd(USER)).toEqual({ kind: "draft", draft: noCutout, tags: null });
  });

  it("drops a draft kept before user IDs were stored", () => {
    plant({ kind: "draft", draft: DRAFT, tags: null });
    expect(takePendingAdd(USER)).toBeNull();
  });

  it("doesn't treat a user ID that merely starts the same as the owner", () => {
    const prefixUser = USER.slice(0, -1);
    plant({ kind: "draft", userId: prefixUser, draft: DRAFT, tags: null });
    expect(takePendingAdd(prefixUser)).toBeNull();
  });
});

describe("pending add with no known user", () => {
  it("keeps nothing", () => {
    keepDraft(null, DRAFT, null);
    notePhotoLost(null);
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
  });

  it("restores nothing and leaves storage alone", () => {
    keepDraft(USER, DRAFT, null);
    expect(takePendingAdd(null)).toBeNull();
    expect(takePendingAdd(USER)).not.toBeNull();
  });
});
