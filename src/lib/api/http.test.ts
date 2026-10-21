import { afterEach, describe, expect, it, vi } from "vitest";
import { describeError, withApiHandler } from "./http";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("describeError", () => {
  it("keeps only name, code and message", () => {
    const error = Object.assign(new Error("connection refused"), {
      code: "ECONNREFUSED",
      config: { headers: { Authorization: "Bearer sb_secret_do_not_log" } },
      request: { body: "private" },
    });
    expect(describeError(error)).toEqual({ name: "Error", code: "ECONNREFUSED", message: "connection refused" });
  });

  it("doesn't dump non-Error values", () => {
    expect(describeError({ secret: "sb_secret_x" })).toEqual({ name: "object", message: "Non-Error value thrown" });
  });
});

describe("withApiHandler logging", () => {
  it("never logs the full error object for unexpected errors", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const handler = withApiHandler(async () => {
      throw Object.assign(new Error("boom"), { headers: { apikey: "sb_secret_do_not_log" } });
    });
    const res = await handler(new Request("http://localhost/api/x"));
    expect(res.status).toBe(500);
    expect(JSON.stringify(log.mock.calls)).not.toContain("sb_secret_do_not_log");
  });
});
