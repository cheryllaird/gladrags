import { describe, expect, it } from "vitest";
import { EMAIL_IMPORT_ERRORS } from "@/contracts";
import { EMAIL_IMPORT_REASONS, emailImportStatus } from "./email-import-copy";

describe("emailImportStatus", () => {
  it("covers every refusal reason in the contract", () => {
    for (const code of EMAIL_IMPORT_ERRORS) expect(EMAIL_IMPORT_REASONS[code]).toMatch(/\.$/);
  });

  it("done, failed, partly done and processing", () => {
    expect(emailImportStatus({ status: "done", itemCount: 3, skippedCount: 0, error: null })).toEqual({ summary: "Added 3 items to review", reason: null });
    expect(emailImportStatus({ status: "failed", itemCount: 0, skippedCount: 0, error: "sender_not_allowed" })).toEqual({
      summary: "Couldn't be added",
      reason: "It wasn't forwarded from your sign-in address.",
    });
    expect(emailImportStatus({ status: "done", itemCount: 1, skippedCount: 2, error: "daily_cap_reached" })).toEqual({
      summary: "Added 1 item to review; 2 items left out",
      reason: EMAIL_IMPORT_REASONS.daily_cap_reached,
    });
    expect(emailImportStatus({ status: "done", itemCount: 0, skippedCount: 0, error: "no_items_found" }).reason).toBe(
      EMAIL_IMPORT_REASONS.no_items_found,
    );
    expect(emailImportStatus({ status: "processing", itemCount: 0, skippedCount: 0, error: null }).summary).toBe("Adding the items…");
  });
});
