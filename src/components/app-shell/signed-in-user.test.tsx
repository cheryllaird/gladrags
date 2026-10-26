// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MOCK_SUGGESTED_TAGS } from "@/lib/mocks/fixtures";
import type { ItemDraft } from "@/contracts";
import { keepDraft, takePendingAdd } from "@/components/wardrobe/add/pending-add";
import { rememberWardrobeSearch, wardrobeReturnPath } from "@/components/wardrobe/wardrobe-return";
import { SignedInUser, forgetOtherUsersData } from "./signed-in-user";

const A = "0a000000-0000-4000-8000-0000000000aa";
const B = "0a000000-0000-4000-8000-0000000000bb";

function draftFor(userId: string): ItemDraft {
  return {
    source: "photo",
    sourceUrl: null,
    originalImageKey: `${userId}/1b000000-0000-4000-8000-000000000001.jpg`,
    cutoutImageKey: null,
    originalUrl: "/mock/items/uploaded.svg",
    cutoutUrl: null,
    suggestedTags: MOCK_SUGGESTED_TAGS,
  };
}

const owner = () => window.sessionStorage.getItem("gladrags:user");

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
});

describe("forgetOtherUsersData", () => {
  it("records the user on a fresh tab", () => {
    forgetOtherUsersData(A);
    expect(owner()).toBe(A);
  });

  it("leaves the same user's data alone", () => {
    forgetOtherUsersData(A);
    rememberWardrobeSearch("?category=top");
    keepDraft(A, draftFor(A), false, null);
    forgetOtherUsersData(A);
    expect(wardrobeReturnPath()).toBe("/wardrobe?category=top");
    expect(takePendingAdd(A)).not.toBeNull();
  });

  it("forgets the previous user's search and kept draft when someone else signs in", () => {
    forgetOtherUsersData(A);
    rememberWardrobeSearch("?q=a-private-search");
    keepDraft(A, draftFor(A), false, null);
    window.sessionStorage.setItem("not-ours", "stays");

    forgetOtherUsersData(B);
    expect(owner()).toBe(B);
    expect(wardrobeReturnPath()).toBe("/wardrobe");
    expect(window.sessionStorage.getItem("gladrags:pending-add")).toBeNull();
    expect(window.sessionStorage.getItem("not-ours")).toBe("stays");
  });

  it("keeps a draft just kept for the user who's now signed in", () => {
    forgetOtherUsersData(A);
    rememberWardrobeSearch("?q=a-private-search");
    keepDraft(B, draftFor(B), true, null);
    forgetOtherUsersData(B);
    expect(wardrobeReturnPath()).toBe("/wardrobe");
    expect(takePendingAdd(B)).toMatchObject({ kind: "draft", cutoutFailed: true });
  });

  it("clears data left in a tab that never recorded a user, except the user's own draft", () => {
    rememberWardrobeSearch("?q=unknown-owner");
    keepDraft(B, draftFor(B), false, null);
    forgetOtherUsersData(B);
    expect(wardrobeReturnPath()).toBe("/wardrobe");
    expect(takePendingAdd(B)).not.toBeNull();
  });
});

describe("<SignedInUser>", () => {
  it("runs the check for the signed-in user", () => {
    forgetOtherUsersData(A);
    rememberWardrobeSearch("?q=a-private-search");
    render(<SignedInUser userId={B} />);
    expect(owner()).toBe(B);
    expect(wardrobeReturnPath()).toBe("/wardrobe");
  });

  it("does nothing without a known user", () => {
    forgetOtherUsersData(A);
    rememberWardrobeSearch("?q=a-search");
    render(<SignedInUser userId={null} />);
    expect(owner()).toBe(A);
    expect(wardrobeReturnPath()).toBe("/wardrobe?q=a-search");
  });
});
