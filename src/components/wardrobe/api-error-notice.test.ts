import { describe, expect, it } from "vitest";
import { ApiClientError } from "@/lib/client/api";
import { PhotoPrepError } from "@/lib/client/photo";
import { errorCopy, formatResetTime } from "./api-error-notice";

describe("formatResetTime (UK time)", () => {
  const now = new Date("2026-10-25T15:00:00Z"); // 15:00 GMT, the day the clocks went back

  it("says 'at midnight' for the daily reset", () => {
    expect(formatResetTime("2026-10-26T00:00:00Z", now)).toBe("at midnight");
  });

  it("gives the date for the monthly reset", () => {
    expect(formatResetTime("2026-11-01T00:00:00Z", now)).toBe("on 1 November");
  });

  it("uses UK summer time, not UTC", () => {
    const summer = new Date("2026-07-10T12:00:00Z");
    // Midnight in London during BST is 23:00 UTC the day before.
    expect(formatResetTime("2026-07-10T23:00:00Z", summer)).toBe("at midnight");
  });
});

describe("errorCopy", () => {
  it("explains the daily cap with its limit and reset", () => {
    const error = new ApiClientError("daily_cap_reached", "cap", {
      cap: { kind: "items_per_day", limit: 40, resetsAt: "2026-10-26T00:00:00Z" },
    });
    const copy = errorCopy(error);
    expect(copy.kind).toBe("cap");
    expect(copy.message).toMatch(/added 40 items today/);
  });

  it("explains the link limit as links, not items, and points to adding by photo", () => {
    const error = new ApiClientError("daily_cap_reached", "cap", {
      cap: { kind: "link_fetches_per_day", limit: 80, resetsAt: "2026-10-26T00:00:00Z" },
    });
    const copy = errorCopy(error);
    expect(copy).toMatchObject({ kind: "cap", title: "That's today's limit for links" });
    expect(copy.message).toMatch(/imported 80 links today/);
    expect(copy.message).toMatch(/by photo/);
    expect(copy.message).not.toMatch(/items today/);
  });

  it("explains the AI pause and that the wardrobe still works", () => {
    const copy = errorCopy(new ApiClientError("ai_paused", "paused"));
    expect(copy).toMatchObject({ kind: "paused", title: "Adding is paused" });
    expect(copy.message).toMatch(/wardrobe still works/);
  });

  it("passes other API messages through", () => {
    expect(errorCopy(new ApiClientError("bad_request", "The photo must be JPEG, PNG, WEBP")).message).toBe(
      "The photo must be JPEG, PNG, WEBP",
    );
  });

  it("explains a photo the phone couldn't read", () => {
    expect(errorCopy(new PhotoPrepError()).title).toBe("Couldn't use that photo");
  });
});
