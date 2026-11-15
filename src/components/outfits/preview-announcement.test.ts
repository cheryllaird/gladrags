import { describe, expect, it } from "vitest";
import { EMPTY_RUNNER_STATE } from "./preview-runner";
import { suggestedPieces } from "./preview-view";
import { previewAnnouncement } from "./use-previews";

describe("previewAnnouncement (the screen's one live line)", () => {
  it("counts through a set", () => {
    const state = { ...EMPTY_RUNNER_STATE, active: { id: "a", refresh: false }, queuedIds: ["a", "b"], progress: { done: 1, total: 4 } };
    expect(previewAnnouncement(state)).toBe("Making picture 2 of 4…");
    expect(previewAnnouncement({ ...state, progress: { done: 0, total: 1 } })).toBe("Making the picture…");
  });

  it("announces an update", () => {
    expect(previewAnnouncement({ ...EMPTY_RUNNER_STATE, active: { id: "a", refresh: true }, queuedIds: ["a"] })).toBe(
      "Updating the picture…",
    );
  });

  it("is quiet while idle or while the sheet is open, and says why pictures wait after it's dismissed", () => {
    expect(previewAnnouncement(EMPTY_RUNNER_STATE)).toBe("");
    expect(previewAnnouncement({ ...EMPTY_RUNNER_STATE, needsPreset: true, queuedIds: ["a"] })).toBe("");
    expect(previewAnnouncement({ ...EMPTY_RUNNER_STATE, presetDismissed: true, queuedIds: ["a"] })).toBe(
      "Outfit pictures are waiting until you pick a model.",
    );
  });
});

describe("suggestedPieces", () => {
  it("drops repeated slots and keys each label by slot", () => {
    expect(suggestedPieces(["shoes", "shoes", "outerwear"], [])).toEqual([
      { slot: "shoes", label: "Shoes suggested" },
      { slot: "outerwear", label: "Outerwear suggested" },
    ]);
  });
});
