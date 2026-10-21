import { describe, expect, it } from "vitest";
import {
  FEEDBACK_KINDS,
  OutfitFeedbackSchema,
  RefineRequestSchema,
  UpdateOutfitStatusRequestSchema,
} from "@/contracts";

const ITEM = "1a000000-0000-4000-8000-000000000011";
const OUTFIT = "2a000000-0000-4000-8000-000000000001";

describe("feedback contracts", () => {
  it("has the spec's feedback kinds", () => {
    expect(FEEDBACK_KINDS).toEqual(["swap", "guidance", "reject"]);
  });

  it("accepts swap and guidance refinements", () => {
    expect(RefineRequestSchema.safeParse({ kind: "swap", itemId: ITEM }).success).toBe(true);
    expect(RefineRequestSchema.safeParse({ kind: "guidance", text: "warmer" }).success).toBe(true);
  });

  it.each([
    [{ kind: "swap" }],
    [{ kind: "swap", itemId: "the shoes" }],
    [{ kind: "guidance", text: "" }],
    [{ kind: "reject" }],
  ])("rejects refinement %j", (value) => {
    expect(RefineRequestSchema.safeParse(value).success).toBe(false);
  });

  it("accepts status updates, with an optional reason only for rejection", () => {
    expect(UpdateOutfitStatusRequestSchema.safeParse({ status: "saved" }).success).toBe(true);
    expect(UpdateOutfitStatusRequestSchema.safeParse({ status: "liked" }).success).toBe(true);
    expect(UpdateOutfitStatusRequestSchema.safeParse({ status: "rejected" }).success).toBe(true);
    expect(
      UpdateOutfitStatusRequestSchema.safeParse({ status: "rejected", reason: "too formal for me" }).success,
    ).toBe(true);
    expect(UpdateOutfitStatusRequestSchema.safeParse({ status: "loved" }).success).toBe(false);
  });

  it("validates stored feedback detail by kind", () => {
    const base = { id: "3a000000-0000-4000-8000-000000000001", outfitId: OUTFIT, createdAt: "2026-10-21T09:00:00Z" };
    expect(OutfitFeedbackSchema.safeParse({ ...base, kind: "swap", detail: ITEM }).success).toBe(true);
    expect(OutfitFeedbackSchema.safeParse({ ...base, kind: "swap", detail: "shoes" }).success).toBe(false);
    expect(OutfitFeedbackSchema.safeParse({ ...base, kind: "reject", detail: null }).success).toBe(true);
    expect(OutfitFeedbackSchema.safeParse({ ...base, kind: "guidance", detail: null }).success).toBe(false);
  });
});
