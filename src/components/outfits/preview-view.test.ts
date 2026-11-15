import { describe, expect, it } from "vitest";
import { NO_PREVIEW, type OutfitGap, type OutfitPreview } from "@/contracts";
import type { ApiFailure } from "./api";
import {
  IDLE_ACTIVITY,
  previewNote,
  previewView,
  problemForError,
  suggestedLabels,
  type PreviewActivity,
} from "./preview-view";

const READY: OutfitPreview = { ...NO_PREVIEW, status: "ready", imageUrl: "https://x.supabase.co/p.webp", presetId: "women_average_medium" };
const BUSY: PreviewActivity = { ...IDLE_ACTIVITY, inProgress: true };
const CAP: ApiFailure = {
  code: "daily_cap_reached",
  message: "Cap",
  cap: { kind: "outfit_previews_per_day", limit: 12, resetsAt: "2026-11-15T00:00:00.000Z" },
};
const PAUSED: ApiFailure = {
  code: "ai_paused",
  message: "Paused",
  cap: { kind: "monthly_image_spend", limit: 200, resetsAt: "2026-12-01T00:00:00.000Z" },
};

function gap(category: OutfitGap["category"], subcategory: OutfitGap["subcategory"]): OutfitGap {
  return { category, subcategory, colours: ["white"], description: "White trainers", shopResults: [], searchedAt: null, shopProduct: null };
}

describe("previewView", () => {
  it("shows the collage as a placeholder while the picture is asked for", () => {
    expect(previewView(NO_PREVIEW, BUSY)).toEqual({ kind: "making", awaitingPreset: false });
    expect(previewView({ ...NO_PREVIEW, status: "pending" }, BUSY)).toEqual({ kind: "making", awaitingPreset: false });
  });

  it("waits for the model pick", () => {
    expect(previewView(NO_PREVIEW, { ...IDLE_ACTIVITY, awaitingPreset: true })).toEqual({ kind: "making", awaitingPreset: true });
  });

  it("shows the picture when it's ready", () => {
    expect(previewView(READY, IDLE_ACTIVITY)).toEqual({
      kind: "image",
      imageUrl: READY.imageUrl,
      outdated: false,
      refreshing: false,
      note: null,
    });
  });

  it("keeps the old picture with Updating while an outdated one refreshes", () => {
    const outdated = { ...READY, outdated: true };
    expect(previewView(outdated, IDLE_ACTIVITY)).toMatchObject({ kind: "image", outdated: true, refreshing: false });
    expect(previewView({ ...outdated, refreshing: true }, IDLE_ACTIVITY)).toMatchObject({ refreshing: true });
    // From the tap, before the server has answered.
    expect(previewView(outdated, BUSY)).toMatchObject({ refreshing: true });
  });

  it("a refused update keeps the picture with a note", () => {
    const view = previewView({ ...READY, outdated: true }, { ...IDLE_ACTIVITY, problem: problemForError(CAP) });
    expect(view).toMatchObject({ kind: "image", outdated: true, note: { title: "That's today's outfit pictures used up" } });
  });

  it("falls back to the collage with its own wording for a failure, the cap and a pause", () => {
    const failed = previewView({ ...NO_PREVIEW, status: "failed", failureReason: "blocked" }, IDLE_ACTIVITY);
    expect(failed).toMatchObject({ kind: "collage", reason: "failed", note: { title: "We couldn't picture this one" } });
    const capped = previewView({ ...NO_PREVIEW, status: "skipped", failureReason: "daily_cap_reached" }, IDLE_ACTIVITY);
    expect(capped).toMatchObject({ kind: "collage", reason: "daily_cap" });
    const paused = previewView({ ...NO_PREVIEW, status: "skipped", failureReason: "ai_paused" }, IDLE_ACTIVITY);
    expect(paused).toMatchObject({ kind: "collage", reason: "paused", note: { title: "Outfit pictures are paused for now" } });
    // From an error the route returned.
    expect(previewView(NO_PREVIEW, { ...IDLE_ACTIVITY, problem: problemForError(PAUSED) })).toMatchObject({ reason: "paused" });
    expect(previewView(NO_PREVIEW, { ...IDLE_ACTIVITY, problem: { kind: "slow" } })).toMatchObject({ reason: "slow" });
  });

  it("an outfit with no picture and nothing asking just shows its collage", () => {
    expect(previewView(NO_PREVIEW, IDLE_ACTIVITY)).toEqual({ kind: "collage", note: null, reason: null });
  });
});

describe("previewNote", () => {
  it("says when the cap resets, in UK time, and how many a day", () => {
    const note = previewNote(problemForError(CAP), "make");
    expect(note.message).toBe("You've had today's pictures (12 a day). Here are the pieces laid out instead. More pictures at Sun 15 Nov, 00:00.");
  });

  it("falls back to midnight without cap details", () => {
    expect(previewNote({ kind: "daily_cap", error: null }, "make").message).toMatch(/at midnight\.$/);
  });

  it("says the pause lasts until the month resets and that outfits still work", () => {
    expect(previewNote(problemForError(PAUSED), "make").message).toBe(
      "GladRags has used this month's picture budget, so pictures are paused until Tue 1 Dec, 00:00. Here are the pieces laid out instead. Outfit ideas still work.",
    );
  });

  it("words an update failure differently from a first failure", () => {
    expect(previewNote({ kind: "failed", error: null }, "update").title).toBe("Couldn't update the picture");
    expect(previewNote({ kind: "failed", error: null }, "update").message).toMatch(/earlier picture stays/);
  });
});

describe("suggestedLabels", () => {
  it("names each suggested piece by its gap's subcategory", () => {
    expect(suggestedLabels(["shoes"], [gap("shoes", "trainers")])).toEqual(["Trainers suggested"]);
  });

  it("falls back to the slot's name", () => {
    expect(suggestedLabels(["outerwear", "shoes"], [gap("shoes", null)])).toEqual(["Outerwear suggested", "Shoes suggested"]);
  });
});
