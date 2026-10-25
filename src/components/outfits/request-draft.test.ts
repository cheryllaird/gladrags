import { describe, expect, it } from "vitest";
import { OutfitRequestSchema } from "@/contracts";
import { EMPTY_DRAFT, draftToRequest } from "./request-draft";

const ANCHOR = "1a000000-0000-4000-8000-000000000008";

describe("draftToRequest", () => {
  it("asks for a style first", () => {
    expect(draftToRequest(EMPTY_DRAFT, null)).toMatchObject({ ok: false, field: "style" });
  });

  it("a preset with guidance and the default count of 4", () => {
    const result = draftToRequest({ ...EMPTY_DRAFT, style: "work", guidance: "  no heels " }, null);
    expect(result).toEqual({
      ok: true,
      request: { style: { kind: "preset", presetId: "work" }, guidance: "no heels", count: 4 },
    });
    if (result.ok) expect(OutfitRequestSchema.safeParse(result.request).success).toBe(true);
  });

  it("leaves blank guidance out", () => {
    const result = draftToRequest({ ...EMPTY_DRAFT, style: "casual", guidance: "   " }, null);
    expect(result.ok && "guidance" in result.request).toBe(false);
  });

  it("a custom style uses the user's words, flattened to one line", () => {
    const result = draftToRequest({ ...EMPTY_DRAFT, style: "custom", customText: "first day\nat a new job" }, null);
    expect(result).toMatchObject({ ok: true, request: { style: { kind: "custom", text: "first day at a new job" } } });
  });

  it("a custom style needs some words", () => {
    expect(draftToRequest({ ...EMPTY_DRAFT, style: "custom", customText: " " }, null)).toMatchObject({
      ok: false,
      field: "customText",
    });
  });

  it("refuses an over-long custom style or guidance", () => {
    expect(draftToRequest({ ...EMPTY_DRAFT, style: "custom", customText: "x".repeat(101) }, null)).toMatchObject({
      ok: false,
      field: "customText",
    });
    expect(draftToRequest({ ...EMPTY_DRAFT, style: "work", guidance: "x".repeat(201) }, null)).toMatchObject({
      ok: false,
      field: "guidance",
    });
  });

  it("a count outside 3-5 is reported against the count field", () => {
    expect(draftToRequest({ ...EMPTY_DRAFT, style: "work", count: 7 }, null)).toMatchObject({ ok: false, field: "count" });
  });

  it("adds the anchor item and the chosen count", () => {
    const result = draftToRequest({ ...EMPTY_DRAFT, style: "evening_out", count: 5 }, ANCHOR);
    expect(result).toMatchObject({ ok: true, request: { anchorItemId: ANCHOR, count: 5 } });
  });
});
