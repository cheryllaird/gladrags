// @vitest-environment jsdom
/**
 * QA: a kept add-item draft (pending-add.ts) read back from storage that a
 * stale tab, another user or tampering could have left. Anything that isn't
 * exactly what keepDraft/notePhotoLost write, for the signed-in user and
 * their own storage folder, must come back as nothing and be deleted.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ItemDraft } from "@/contracts";
import { MOCK_SUGGESTED_TAGS } from "@/lib/mocks/fixtures";
import { keepDraft, notePhotoLost, takePendingAdd } from "./pending-add";

const USER = "0a000000-0000-4000-8000-000000000001";
const OTHER = "0a000000-0000-4000-8000-000000000002";
const KEY = "gladrags:pending-add";
const IMAGE = "1b000000-0000-4000-8000-000000000001.jpg";
const CUTOUT = "1b000000-0000-4000-8000-000000000002.png";

const DRAFT: ItemDraft = {
  source: "photo",
  sourceUrl: null,
  originalImageKey: `${USER}/${IMAGE}`,
  cutoutImageKey: `${USER}/${CUTOUT}`,
  originalUrl: "/mock/items/uploaded.svg",
  cutoutUrl: "/mock/items/uploaded.svg",
  suggestedTags: MOCK_SUGGESTED_TAGS,
};

const kept = (
  overrides: Record<string, unknown> = {},
  draft: Record<string, unknown> = {},
) => ({
  kind: "draft",
  userId: USER,
  draft: { ...DRAFT, ...draft },
  cutoutFailed: false,
  tags: null,
  ...overrides,
});

function plantRaw(raw: string) {
  window.sessionStorage.setItem(KEY, raw);
}
const plant = (value: unknown) => plantRaw(JSON.stringify(value));

/** Nothing comes back for USER, and the entry is gone afterwards. */
function expectDroppedFor(userId: string) {
  expect(takePendingAdd(userId)).toBeNull();
  expect(window.sessionStorage.getItem(KEY)).toBeNull();
}

afterEach(() => {
  window.sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("a well-formed entry (control)", () => {
  it("is restored for its owner", () => {
    plant(kept());
    expect(takePendingAdd(USER)).toMatchObject({ kind: "draft", draft: DRAFT });
  });
});

describe("tampered entries: wrong types", () => {
  it.each<[string, unknown]>([
    ["userId as a number", kept({ userId: 1 })],
    ["userId empty", kept({ userId: "" })],
    ["userId null", kept({ userId: null })],
    ["cutoutFailed as a string", kept({ cutoutFailed: "false" })],
    ["cutoutFailed missing", (({ cutoutFailed: _c, ...rest }) => rest)(kept())],
    ["tags as a string", kept({ tags: "shirt" })],
    ["tags missing (not null)", (({ tags: _t, ...rest }) => rest)(kept())],
    ["an unknown kind", kept({ kind: "item" })],
    ["no kind", (({ kind: _k, ...rest }) => rest)(kept())],
    ["draft as a string", kept({ draft: "draft" })],
    ["draft null", kept({ draft: null })],
    ["the original key as a number", kept({}, { originalImageKey: 42 })],
    ["the source not in the vocabulary", kept({}, { source: "camera" })],
    [
      "a javascript: source link",
      kept({}, { source: "link", sourceUrl: "javascript:alert(1)" }),
    ],
    [
      "a data: source link",
      kept(
        {},
        {
          source: "link",
          sourceUrl: "data:text/html,<script>alert(1)</script>",
        },
      ),
    ],
  ])("drops %s", (_label, value) => {
    plant(value);
    expectDroppedFor(USER);
  });

  it.each<[string, string]>([
    ["invalid JSON", "{not json"],
    ["an empty string", ""],
    ["JSON null", "null"],
    ["a JSON number", "42"],
    ["a JSON string", JSON.stringify(JSON.stringify(kept()))],
    ["a JSON array", JSON.stringify([kept()])],
    ["a truncated entry", JSON.stringify(kept()).slice(0, 80)],
  ])("drops %s", (_label, raw) => {
    plantRaw(raw);
    expectDroppedFor(USER);
  });

  it("drops a photo_lost note with someone else's or no user ID", () => {
    plant({ kind: "photo_lost", userId: OTHER });
    expectDroppedFor(USER);
    plant({ kind: "photo_lost" });
    expectDroppedFor(USER);
    plant({ kind: "photo_lost", userId: "" });
    expectDroppedFor(USER);
  });
});

describe("tampered entries: extra fields", () => {
  it("restores a valid draft but doesn't pass extra fields on to the screen", () => {
    plant(
      kept({ admin: true, userId: USER }, { userId: OTHER, extra: "<script>" }),
    );
    const restored = takePendingAdd(USER);
    expect(restored).not.toBeNull();
    expect(restored).not.toHaveProperty("admin");
    expect(restored).not.toHaveProperty("userId");
    expect(
      restored && restored.kind === "draft" && restored.draft,
    ).not.toHaveProperty("extra");
    expect(
      restored && restored.kind === "draft" && restored.draft,
    ).not.toHaveProperty("userId");
  });

  it("doesn't let a photo_lost note carry a draft", () => {
    plant({
      kind: "photo_lost",
      userId: USER,
      draft: DRAFT,
      tags: MOCK_SUGGESTED_TAGS,
    });
    expect(takePendingAdd(USER)).toEqual({ kind: "photo_lost" });
  });
});

describe("tampered entries: image keys", () => {
  it.each<[string, Record<string, unknown>]>([
    [
      "the right user ID with someone else's original",
      { originalImageKey: `${OTHER}/${IMAGE}` },
    ],
    [
      "the right user ID with someone else's cut-out",
      { cutoutImageKey: `${OTHER}/${CUTOUT}` },
    ],
    [
      "a folder that only starts with the user ID",
      { originalImageKey: `${USER}x/${IMAGE}` },
    ],
    [
      "a folder with the user ID as its prefix (no slash)",
      { originalImageKey: `${USER}${IMAGE}` },
    ],
    [
      "a path that climbs out of the folder",
      { originalImageKey: `${USER}/../${OTHER}/${IMAGE}` },
    ],
    [
      "a cut-out that climbs out of the folder",
      { cutoutImageKey: `${USER}/../${OTHER}/${CUTOUT}` },
    ],
    [
      "an encoded climb",
      { originalImageKey: `${USER}/..%2F${OTHER}%2F${IMAGE}` },
    ],
    ["a nested folder", { originalImageKey: `${USER}/${OTHER}/${IMAGE}` }],
    ["a leading slash", { originalImageKey: `/${USER}/${IMAGE}` }],
    ["upper-case IDs", { originalImageKey: `${USER.toUpperCase()}/${IMAGE}` }],
    [
      "a wrong extension",
      { originalImageKey: `${USER}/1b000000-0000-4000-8000-000000000001.svg` },
    ],
    ["a trailing newline", { originalImageKey: `${USER}/${IMAGE}\n` }],
    ["an empty cut-out key", { cutoutImageKey: "" }],
  ])("drops %s", (_label, draft) => {
    plant(kept({}, draft));
    expectDroppedFor(USER);
  });

  it("drops another user's draft even when its keys were rewritten to look like this user's", () => {
    // The entry's own userId still names the other user.
    plant(kept({ userId: OTHER }));
    expectDroppedFor(USER);
  });
});

describe("a huge entry", () => {
  it("drops a draft whose tags exceed the contract's limits", () => {
    plant(
      kept({
        tags: { ...MOCK_SUGGESTED_TAGS, description: "x".repeat(200_000) },
      }),
    );
    expectDroppedFor(USER);
  });

  it("drops a valid-looking entry padded with megabytes of junk without throwing", () => {
    plant(kept({}, { originalUrl: "/mock/" + "a".repeat(2_000_000) }));
    // The URL is only checked as non-empty, so this one may restore; the
    // point is that reading it neither throws nor leaves it behind.
    expect(() => takePendingAdd(USER)).not.toThrow();
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
  });
});

describe("storage failures", () => {
  it("keepDraft and notePhotoLost don't throw when storage is full", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError");
    });
    expect(() => keepDraft(USER, DRAFT, false, null)).not.toThrow();
    expect(() => notePhotoLost(USER)).not.toThrow();
  });

  it("takePendingAdd returns null when storage is blocked", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("SecurityError");
    });
    expect(takePendingAdd(USER)).toBeNull();
  });
});

describe("one user after another on the same tab", () => {
  it("a later keep for one user replaces an earlier one for another", () => {
    keepDraft(
      OTHER,
      { ...DRAFT, originalImageKey: `${OTHER}/${IMAGE}`, cutoutImageKey: null },
      false,
      null,
    );
    notePhotoLost(USER);
    expect(takePendingAdd(USER)).toEqual({ kind: "photo_lost" });
  });

  it("the first user's lost-photo note is gone once the second user has looked", () => {
    notePhotoLost(USER);
    expectDroppedFor(OTHER);
    expect(takePendingAdd(USER)).toBeNull();
  });
});
