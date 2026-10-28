/**
 * CSRF protection in the API layer (src/lib/api/http.ts): unsafe methods
 * from another origin are refused before the handler runs, and JSON
 * routes only accept Content-Type: application/json.
 */
import { NextResponse } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ApiErrorSchema, API_ERROR_STATUS } from "@/contracts";
import { isCrossSiteRequest, isJsonContentType, parseJsonBody, withApiHandler } from "./http";

const BASE = "https://gladrags.example";

afterEach(() => {
  vi.unstubAllEnvs();
});

function request(method: string, headers: Record<string, string> = {}, body?: string) {
  return new Request(`${BASE}/api/items`, { method, headers, body });
}

const handlerSpy = () => vi.fn(async () => NextResponse.json({ ran: true }));

async function codeOf(res: Response) {
  return ApiErrorSchema.parse(await res.json()).error.code;
}

describe("cross-site requests", () => {
  it.each(["POST", "PATCH", "PUT", "DELETE"])("%s from another origin: 403 forbidden, handler not run", async (method) => {
    const handler = handlerSpy();
    const res = await withApiHandler(handler)(request(method, { origin: "https://evil.example" }));
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe("forbidden");
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([
    ["an opaque origin", { origin: "null" }],
    ["a different port", { origin: "https://gladrags.example:8443" }],
    ["http instead of https", { origin: "http://gladrags.example" }],
    ["a look-alike subdomain", { origin: "https://gladrags.example.evil.example" }],
    ["no Origin, Sec-Fetch-Site cross-site", { "sec-fetch-site": "cross-site" }],
  ])("refuses %s", (_label, headers) => {
    expect(isCrossSiteRequest(request("POST", headers))).toBe(true);
  });

  it.each([
    ["the request's own origin", { origin: BASE }],
    ["no Origin at all (curl, server-to-server)", {}],
    ["no Origin, same-origin fetch metadata", { "sec-fetch-site": "same-origin" }],
  ])("allows %s", (_label, headers) => {
    expect(isCrossSiteRequest(request("POST", headers))).toBe(false);
  });

  it.each([
    ["Origin null (a no-referrer page's own form)", { origin: "null", "sec-fetch-site": "same-origin" }],
    ["a LAN address the server doesn't know itself by (testing on a phone)", { origin: "http://192.168.1.20:3000", "sec-fetch-site": "same-origin" }],
    ["a public host in front of a proxy", { origin: "https://public.example", "sec-fetch-site": "same-origin" }],
  ])("trusts the browser's Sec-Fetch-Site: same-origin: %s", (_label, headers) => {
    expect(isCrossSiteRequest(request("POST", headers))).toBe(false);
  });

  it.each([
    ["same-site (a sibling subdomain) with a foreign Origin", { origin: "https://evil.gladrags.example", "sec-fetch-site": "same-site" }],
    ["same-site with Origin null", { origin: "null", "sec-fetch-site": "same-site" }],
    ["cross-site with this site's Origin claimed", { origin: "https://evil.example", "sec-fetch-site": "cross-site" }],
    ["none (typed or bookmarked) with a foreign Origin", { origin: "https://evil.example", "sec-fetch-site": "none" }],
  ])("still refuses %s", (_label, headers) => {
    expect(isCrossSiteRequest(request("POST", headers))).toBe(true);
  });

  it("allows NEXT_PUBLIC_SITE_URL's origin (e.g. behind a proxy)", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://app.gladrags.example/");
    expect(isCrossSiteRequest(request("POST", { origin: "https://app.gladrags.example" }))).toBe(false);
    expect(isCrossSiteRequest(request("POST", { origin: "https://other.example" }))).toBe(true);
  });

  it("ignores a malformed NEXT_PUBLIC_SITE_URL rather than failing", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "not a url");
    expect(isCrossSiteRequest(request("POST", { origin: BASE }))).toBe(false);
  });

  it.each(["GET", "HEAD", "OPTIONS"])("never blocks %s (safe methods change nothing)", async (method) => {
    const handler = handlerSpy();
    const res = await withApiHandler(handler)(request(method, { origin: "https://evil.example" }));
    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalled();
  });

  it("forbidden is a 403 in the contract", () => {
    expect(API_ERROR_STATUS.forbidden).toBe(403);
  });
});

describe("JSON content type", () => {
  const Schema = z.object({ a: z.number() });
  const route = withApiHandler(async (req: Request) => NextResponse.json(await parseJsonBody(req, Schema)));

  it.each(["application/json", "application/json; charset=utf-8", "Application/JSON"])("accepts %s", async (type) => {
    const res = await route(request("POST", { "content-type": type, origin: BASE }, '{"a":1}'));
    expect(res.status).toBe(200);
  });

  it.each([
    ["no content type", {}],
    ["text/plain (what a cross-site form or no-cors fetch can send)", { "content-type": "text/plain" }],
    ["a form", { "content-type": "application/x-www-form-urlencoded" }],
    ["multipart", { "content-type": "multipart/form-data; boundary=x" }],
    ["a look-alike", { "content-type": "application/jsonx" }],
  ])("refuses %s with 415 unsupported_media_type", async (_label, headers) => {
    const res = await route(request("POST", { ...headers, origin: BASE }, '{"a":1}'));
    expect(res.status).toBe(415);
    expect(await codeOf(res)).toBe("unsupported_media_type");
  });

  it("still answers bad_request for JSON that doesn't parse or fit", async () => {
    expect((await route(request("POST", { "content-type": "application/json" }, "{nope"))).status).toBe(400);
    expect((await route(request("POST", { "content-type": "application/json" }, '{"a":"x"}'))).status).toBe(400);
  });

  it("isJsonContentType", () => {
    expect(isJsonContentType(null)).toBe(false);
    expect(isJsonContentType("application/json;charset=UTF-8")).toBe(true);
    expect(isJsonContentType("application/problem+json")).toBe(false);
  });
});
