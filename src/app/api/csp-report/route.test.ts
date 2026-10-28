/**
 * POST /api/csp-report: accepts both report formats from any page (no
 * CSRF check, no sign-in), logs only the directive and the blocked
 * source's origin, refuses big bodies and caps how much it logs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LogBudget, blockedSource, summariseCspReports } from "@/lib/api/csp-report";

const BASE = "https://gladrags.example";

function post(body: string, headers: Record<string, string> = { "content-type": "application/csp-report" }) {
  return new Request(`${BASE}/api/csp-report`, { method: "POST", headers, body });
}

const legacy = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    "csp-report": {
      "document-uri": `${BASE}/wardrobe/1a000000-0000-4000-8000-000000000001?token=secret-token`,
      referrer: `${BASE}/auth/confirm?token_hash=abc123`,
      "effective-directive": "script-src-elem",
      "violated-directive": "script-src-elem",
      "blocked-uri": "https://vercel.live/_next-live/feedback/feedback.js?dpl=dpl_secret",
      "script-sample": "tester@example.com",
      ...overrides,
    },
  });

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.resetModules();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

async function route() {
  return (await import("./route")).POST;
}

describe("POST /api/csp-report", () => {
  it("logs only the directive and the blocked origin from a report-uri report, and answers 204", async () => {
    const res = await (await route())(post(legacy()));
    expect(res.status).toBe(204);
    expect(warn).toHaveBeenCalledWith("CSP report", { directive: "script-src-elem", blocked: "https://vercel.live" });
    const logged = JSON.stringify(warn.mock.calls);
    for (const secret of ["secret-token", "abc123", "tester@example.com", "dpl_secret", "1a000000", "feedback.js"]) expect(logged).not.toContain(secret);
  });

  it("reads Reporting API (report-to) batches", async () => {
    const body = JSON.stringify([
      { type: "csp-violation", url: `${BASE}/add?x=private`, body: { effectiveDirective: "img-src", blockedURL: "https://evil.example/pixel.gif?u=1", documentURL: `${BASE}/add` } },
      { type: "csp-violation", body: { effectiveDirective: "script-src-elem", blockedURL: "inline", sample: "alert(1)" } },
      { type: "deprecation", body: { message: "ignored" } },
    ]);
    const res = await (await route())(post(body, { "content-type": "application/reports+json" }));
    expect(res.status).toBe(204);
    expect(warn.mock.calls).toEqual([
      ["CSP report", { directive: "img-src", blocked: "https://evil.example" }],
      ["CSP report", { directive: "script-src-elem", blocked: "inline" }],
    ]);
  });

  it("is reachable from another origin and without any CSRF headers (browsers send these themselves)", async () => {
    const res = await (await route())(post(legacy(), { "content-type": "application/csp-report", origin: "null", "sec-fetch-site": "cross-site" }));
    expect(res.status).toBe(204);
  });

  it("refuses a body over 16 KB unread (413), by its declared length or its real length", async () => {
    const big = legacy({ "script-sample": "x".repeat(20_000) });
    const POST = await route();
    expect((await POST(post(big))).status).toBe(413);
    expect((await POST(post(big, { "content-type": "application/csp-report", "content-length": "100" }))).status).toBe(413);
    expect(warn).not.toHaveBeenCalled();
  });

  it("ignores junk: not JSON, the wrong shape, odd directives", async () => {
    const POST = await route();
    expect((await POST(post("not json"))).status).toBe(204);
    expect((await POST(post(JSON.stringify({ hello: "world" })))).status).toBe(204);
    expect(warn).not.toHaveBeenCalled();
    await POST(post(legacy({ "effective-directive": "script-src\n<b>forged</b>", "violated-directive": undefined })));
    expect(warn).toHaveBeenCalledWith("CSP report", { directive: "unknown", blocked: "https://vercel.live" });
  });

  it("logs at most 60 reports a minute per instance, and still answers 204", async () => {
    const POST = await route();
    for (let i = 0; i < 70; i++) expect((await POST(post(legacy()))).status).toBe(204);
    expect(warn).toHaveBeenCalledTimes(60);
  });

  it("reads at most 10 reports from one batch", async () => {
    const body = JSON.stringify(Array.from({ length: 50 }, () => ({ type: "csp-violation", body: { effectiveDirective: "img-src", blockedURL: "data" } })));
    await (await route())(post(body, { "content-type": "application/reports+json" }));
    expect(warn).toHaveBeenCalledTimes(10);
  });
});

describe("blockedSource", () => {
  it.each([
    ["https://cdn.example/a.js?token=1", "https://cdn.example"],
    ["http://localhost:3000/x", "http://localhost:3000"],
    ["inline", "inline"],
    ["eval", "eval"],
    ["wasm-eval", "wasm-eval"],
    ["data", "data"],
    ["data:image/png;base64,AAAA", "data"],
    ["blob:https://gladrags.example/uuid", "blob"],
    ["", "none"],
    [undefined, "none"],
    ["javascript-ish nonsense", "other"],
  ])("%s -> %s", (input, expected) => {
    expect(blockedSource(input)).toBe(expected);
  });

  it("summariseCspReports skips anything that isn't a report", () => {
    expect(summariseCspReports(null)).toEqual([]);
    expect(summariseCspReports([1, "x", { type: "csp-violation" }])).toEqual([]);
  });

  it("LogBudget resets each minute", () => {
    let now = 0;
    const budget = new LogBudget(2, () => now);
    expect([budget.take(), budget.take(), budget.take()]).toEqual([true, true, false]);
    now = 60_000;
    expect(budget.take()).toBe(true);
  });
});
