/** Round 2: mapping an outfit_previews row to the API preview. */
import { describe, expect, it } from "vitest";
import { OutfitPreviewRowSchema, OutfitPreviewSchema, type OutfitPreviewRow } from "@/contracts";
import { previewRowToOutfitPreview } from "./mappers";

const row: OutfitPreviewRow = OutfitPreviewRowSchema.parse({
  id: "8a300000-0000-4000-8000-000000000001",
  user_id: "8a000000-0000-4000-8000-00000000008a",
  cache_key: "a".repeat(64),
  preset_id: "women_curvy_medium",
  item_ids: ["8a100000-0000-4000-8000-000000000001"],
  suggested_slots: ["bottom", "shoes"],
  status: "ready",
  image_key: "8a000000-0000-4000-8000-00000000008a/00000000-0000-4000-8000-0000000000f1.webp",
  failure_reason: null,
  attempted_at: "2026-11-13 10:00:00+00",
  created_at: "2026-11-13 10:00:00+00",
  updated_at: "2026-11-13 10:00:00+00",
});

describe("previewRowToOutfitPreview", () => {
  it("no row is no preview", () => {
    expect(previewRowToOutfitPreview({ preview_outdated: false }, null, null).status).toBe("none");
  });

  it("a ready row with its signed URL, the suggested slots and the outdated flag", () => {
    const preview = previewRowToOutfitPreview({ preview_outdated: true }, row, "https://x.supabase.co/sign/p.webp");
    expect(preview).toEqual({
      status: "ready",
      imageUrl: "https://x.supabase.co/sign/p.webp",
      failureReason: null,
      presetId: "women_curvy_medium",
      suggestedSlots: ["bottom", "shoes"],
      outdated: true,
      refreshing: false,
    });
    expect(OutfitPreviewSchema.safeParse(preview).success).toBe(true);
  });

  it("a refresh in progress reads as refreshing, still showing the old picture", () => {
    const preview = previewRowToOutfitPreview(
      { preview_outdated: true, pending_preview_id: "8a300000-0000-4000-8000-000000000002" },
      row,
      "https://x.supabase.co/sign/p.webp",
    );
    expect(preview).toMatchObject({ status: "ready", outdated: true, refreshing: true });
  });

  it("a ready row whose image can't be signed reads as failed (internal), never as none", () => {
    const preview = previewRowToOutfitPreview({ preview_outdated: false }, row, null);
    expect(preview).toMatchObject({ status: "failed", failureReason: "internal", imageUrl: null });
    expect(OutfitPreviewSchema.safeParse(preview).success).toBe(true);
  });

  it("pending, failed and skipped rows", () => {
    for (const [status, failure_reason] of [["pending", null], ["failed", "blocked"], ["skipped", "daily_cap_reached"]] as const) {
      const preview = previewRowToOutfitPreview({ preview_outdated: false }, { ...row, status, failure_reason, image_key: null }, null);
      expect(preview).toMatchObject({ status, failureReason: failure_reason, imageUrl: null });
      expect(OutfitPreviewSchema.safeParse(preview).success).toBe(true);
    }
  });
});
