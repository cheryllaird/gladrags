// @vitest-environment jsdom
// QA tests for the draft review step: the background-removal fallback, the
// empty-tags fallback, what gets saved (tagsEdited, image keys, source link),
// and that a failed save keeps the user's corrections for a retry.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ItemDraft, ItemTags, WardrobeItem } from "@/contracts";
import { ApiClientError, createItem } from "@/lib/client/api";
import { DraftReview } from "./draft-review";

vi.mock("@/lib/client/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client/api")>();
  return { ...actual, createItem: vi.fn() };
});

Element.prototype.scrollIntoView = vi.fn();

const USER = "0a000000-0000-4000-8000-000000000001";
const ORIGINAL_KEY = `${USER}/1b000000-0000-4000-8000-000000000001.jpg`;
const CUTOUT_KEY = `${USER}/1b000000-0000-4000-8000-000000000002.png`;

const TAGS: ItemTags = {
  category: "bottom",
  subcategory: "chinos",
  colours: ["tan"],
  pattern: "plain",
  formality: 3,
  seasons: ["spring", "summer", "autumn"],
  warmth: "medium",
  occasions: ["smart_casual", "work"],
  fabric: "cotton",
  description: "Tan slim chinos",
};

const DRAFT: ItemDraft = {
  source: "photo",
  sourceUrl: null,
  originalImageKey: ORIGINAL_KEY,
  cutoutImageKey: CUTOUT_KEY,
  originalUrl: "/mock/original.jpg",
  cutoutUrl: "/mock/cutout.png",
  suggestedTags: TAGS,
};

function saved(tags: ItemTags): WardrobeItem {
  return {
    id: "1c000000-0000-4000-8000-000000000001",
    source: "photo",
    sourceUrl: null,
    originalUrl: DRAFT.originalUrl,
    cutoutUrl: DRAFT.cutoutUrl,
    tags,
    tagsEdited: false,
    createdAt: "2026-10-25T10:00:00.000Z",
  };
}

beforeEach(() => {
  vi.mocked(createItem).mockReset();
});
afterEach(cleanup);

function renderReview(draft: ItemDraft, cutoutFailed = false) {
  const onSaved = vi.fn();
  const onDiscard = vi.fn();
  const user = userEvent.setup();
  render(<DraftReview userId={null} draft={draft} cutoutFailed={cutoutFailed} onSaved={onSaved} onDiscard={onDiscard} />);
  return { user, onSaved, onDiscard, save: () => user.click(screen.getByRole("button", { name: "Save to wardrobe" })) };
}

describe("background removal fallback", () => {
  it("when removal failed on the phone, says so and shows the original image", () => {
    renderReview({ ...DRAFT, cutoutImageKey: null, cutoutUrl: null }, true);
    expect(screen.getByText(/couldn't cut this one out on your phone/)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "The item you're adding" })).toHaveAttribute("src", DRAFT.originalUrl);
  });

  it("shows the cut-out when there is one, with no fallback message", () => {
    renderReview(DRAFT);
    expect(screen.getByRole("img", { name: "The item you're adding" })).toHaveAttribute("src", DRAFT.cutoutUrl);
    expect(screen.queryByText(/original (photo|image) will be used/)).toBeNull();
  });

  it("saves with no cut-out key when removal failed", async () => {
    vi.mocked(createItem).mockResolvedValue(saved(TAGS));
    const { save } = renderReview({ ...DRAFT, cutoutImageKey: null, cutoutUrl: null }, true);
    await save();
    expect(createItem).toHaveBeenCalledWith(expect.objectContaining({ cutoutImageKey: null, originalImageKey: ORIGINAL_KEY }));
  });
});

describe("what gets saved", () => {
  it("unchanged suggested tags are saved with tagsEdited false", async () => {
    vi.mocked(createItem).mockResolvedValue(saved(TAGS));
    const { save, onSaved } = renderReview(DRAFT);
    await save();
    expect(createItem).toHaveBeenCalledWith({
      source: "photo",
      sourceUrl: null,
      originalImageKey: ORIGINAL_KEY,
      cutoutImageKey: CUTOUT_KEY,
      tags: TAGS,
      tagsEdited: false,
    });
    expect(onSaved).toHaveBeenCalled();
  });

  it("a corrected tag is saved with tagsEdited true", async () => {
    vi.mocked(createItem).mockResolvedValue(saved(TAGS));
    const { user, save } = renderReview(DRAFT);
    await user.click(within(screen.getByRole("group", { name: "Warmth" })).getByRole("radio", { name: "Light" }));
    await save();
    expect(createItem).toHaveBeenCalledWith(expect.objectContaining({ tags: { ...TAGS, warmth: "light" }, tagsEdited: true }));
  });

  it("the screenshot fallback keeps its link: source 'link' and the sourceUrl go into the save", async () => {
    vi.mocked(createItem).mockResolvedValue(saved(TAGS));
    const link = "https://blocked.example.com/p/1";
    const { save } = renderReview({ ...DRAFT, source: "link", sourceUrl: link });
    await save();
    expect(createItem).toHaveBeenCalledWith(expect.objectContaining({ source: "link", sourceUrl: link }));
  });

  it("empty tags (tagging failed) explain themselves and can't be saved until filled in", async () => {
    const { save } = renderReview({ ...DRAFT, suggestedTags: null });
    expect(screen.getByText("Fill in the tags")).toBeInTheDocument();
    await save();
    expect(createItem).not.toHaveBeenCalled();
  });
});

describe("a failed save", () => {
  it("shows the error, keeps the user's corrections and lets them try again", async () => {
    vi.mocked(createItem)
      .mockRejectedValueOnce(new ApiClientError("internal", "Something went wrong. Try again.", { status: 500 }))
      .mockResolvedValueOnce(saved(TAGS));
    const { user, save, onSaved } = renderReview(DRAFT);
    const description = screen.getByLabelText("Description");
    await user.clear(description);
    await user.type(description, "Stone chinos");
    await save();

    expect(await screen.findByText("Something went wrong. Try again.")).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Description")).toHaveValue("Stone chinos");
    expect(screen.getByRole("button", { name: "Save to wardrobe" })).toBeEnabled();

    await save();
    expect(onSaved).toHaveBeenCalled();
    expect(vi.mocked(createItem).mock.calls[1]![0].tags.description).toBe("Stone chinos");
  });

  it("disables both buttons while saving", async () => {
    let finish: (item: WardrobeItem) => void = () => {};
    vi.mocked(createItem).mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    const { save } = renderReview(DRAFT);
    await save();
    try {
      expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Discard" })).toBeDisabled();
      fireEvent.click(screen.getByRole("button", { name: "Saving…" }));
      expect(createItem).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => finish(saved(TAGS)));
    }
  });

  // Enter (or "Go" on a phone keyboard) in a text field submits the form
  // implicitly; that must not save a second copy. It holds because implicit
  // submission is blocked while the form's submit button is disabled.
  it("pressing Enter in the description while a save is in flight doesn't save a second copy", async () => {
    let finish: (item: WardrobeItem) => void = () => {};
    vi.mocked(createItem).mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    const { save, user } = renderReview(DRAFT);
    await save();
    try {
      await user.type(screen.getByLabelText("Description"), "{Enter}");
      expect(createItem).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => finish(saved(TAGS)));
    }
  });
});
