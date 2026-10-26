/**
 * Add by link, step 1, against a local server standing in for the shops
 * (no real network): the happy paths for each page shape, every fallback,
 * and the image checks (sniffed type, decoded, EXIF stripped, ≤ 1600 px).
 */
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiErrorSchema, LINK_IMAGE_URL_TTL_SECONDS, LinkImportResponseSchema, STORAGE_BUCKETS, type LinkImportResponse } from "@/contracts";
import { ApiException } from "@/lib/api/errors";
import { DAILY_CAPS } from "@/lib/usage/config";
import { CapReachedError } from "@/lib/usage/errors";
import { OTHER_USER, TEST_LIMITS, TEST_USER } from "@/test/ingestion-deps";
import { phoneJpeg, phonePng, phoneWebp, readMetadata } from "@/test/images";
import { LINK_IMPORTS_PER_DAY, LINK_IMPORT_WINDOW_MS, MIN_PRODUCT_IMAGE_PX, importFromLink } from "./import-link";
import {
  PUBLIC_V4,
  bytes,
  fixture,
  html,
  makeLinkDeps,
  redirect,
  startTestServer,
  testNetwork,
  type TestNetwork,
  type TestServer,
} from "./test-support";

let server: TestServer;
let network: TestNetwork;
let deps: ReturnType<typeof makeLinkDeps>;

const HOSTS = [
  "www.hartleylowe.example",
  "images.hartleylowe.example",
  "northfield.example",
  "cdn.northfield.example",
  "fenwick.example",
  "denimco.example",
  "img.denimco.example",
  "ashby.example",
  "blog.example",
  "shop.example",
  "cdn.shop.example",
];

let productJpeg: Uint8Array;

beforeEach(async () => {
  server = await startTestServer();
  network = testNetwork(server.port, {
    ...Object.fromEntries(HOSTS.map((h) => [h, [PUBLIC_V4]])),
    "evil-cdn.example": ["169.254.169.254"],
  });
  deps = makeLinkDeps(network);
  productJpeg = (await phoneJpeg({ width: 2000, height: 2400 })).data;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  await server.close();
  vi.restoreAllMocks();
});

async function run(url: string): Promise<LinkImportResponse> {
  // Every answer must satisfy the contract.
  return LinkImportResponseSchema.parse(await importFromLink(deps, TEST_USER, url));
}

/** The local test server speaks plain http; the https path differs only in the transport module. */
function httpOnly(page: string): string {
  return page.replaceAll("https://", "http://");
}

function expectOk(result: LinkImportResponse) {
  if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}: ${"reason" in result ? result.reason : ""}`);
  return result;
}

describe("step 1 succeeds", () => {
  it("JSON-LD page: stores a cleaned ≤ 1600 px original, records the import and returns a 10-minute URL", async () => {
    server.routes.set("www.hartleylowe.example/products/linen-shirt", html(httpOnly(fixture("jsonld-only.html"))));
    server.routes.set("images.hartleylowe.example/p/hl-2291-nvy-front.jpg", bytes(productJpeg, "image/jpeg"));
    const url = "http://www.hartleylowe.example/products/linen-shirt";

    const result = expectOk(await run(url));
    expect(result.sourceUrl).toBe(url);
    expect(result.product).toEqual({ title: "Relaxed Linen Shirt – Navy Stripe", brand: "Hartley & Lowe", colour: "Navy/White" });
    expect(result.originalImageKey.startsWith(`${TEST_USER}/`)).toBe(true);
    expect(result.originalUrl).toBe(`memory://originals/${result.originalImageKey}?ttl=${LINK_IMAGE_URL_TTL_SECONDS}`);

    const stored = deps.storage.get(STORAGE_BUCKETS.originals, result.originalImageKey)!;
    const meta = await readMetadata(stored);
    expect(meta.format).toBe("jpeg");
    expect(Math.max(meta.width!, meta.height!)).toBe(1600);
    expect(meta.exif).toBeUndefined();
    expect(meta.mentionsCamera).toBe(false);

    // The server keeps its own copy of the product data for step 2.
    expect(await deps.linkImports.findOpen(TEST_USER, result.originalImageKey)).toEqual({ sourceUrl: url, product: result.product });
    // Step 1 doesn't count the item.
    expect((await deps.usage.summary(TEST_USER)).itemsToday.used).toBe(0);
  });

  it("Open Graph only page", async () => {
    server.routes.set("northfield.example/boots/chelsea-tan", html(httpOnly(fixture("og-only.html"))));
    server.routes.set("cdn.northfield.example/img/chelsea-tan-1.jpg?w=2000", bytes((await phoneWebp({ width: 800, height: 900 })).data, "image/webp"));
    const result = expectOk(await run("http://northfield.example/boots/chelsea-tan"));
    expect(result.product).toEqual({ title: "Chelsea Boots in Tan Suede", brand: "Northfield", colour: "Tan" });
    expect(result.originalImageKey.endsWith(".webp")).toBe(true);
  });

  it("@graph page with a relative image URL, reached through a redirect (relative URLs resolve against the final page)", async () => {
    server.routes.set("fenwick.example/p/123", redirect("http://fenwick.example/products/wool-overcoat", 301));
    server.routes.set("fenwick.example/products/wool-overcoat", html(fixture("jsonld-graph.html")));
    server.routes.set("fenwick.example/cdn/shop/products/wool-overcoat-camel_1800x.jpg", bytes(productJpeg, "image/jpeg"));
    const result = expectOk(await run("http://fenwick.example/p/123"));
    expect(result.product.title).toBe("Wool Overcoat – Camel");
    // The pasted link is what's kept on the item.
    expect(result.sourceUrl).toBe("http://fenwick.example/p/123");
  });

  it("ProductGroup with protocol-relative variant images; CDNs sending octet-stream are fine (the bytes decide)", async () => {
    server.routes.set("denimco.example/jeans", html(fixture("jsonld-array-variants.html")));
    server.routes.set("img.denimco.example/slj-01/mid-blue.jpg", bytes(productJpeg, "application/octet-stream"));
    // Protocol-relative URLs take the page's scheme (http here).
    const result = expectOk(await run("http://denimco.example/jeans"));
    expect(result.product).toEqual({ title: "Straight Leg Jeans", brand: "Denim Co", colour: "Mid Blue" });
  });

  it("falls through to the next image when the first is missing, not an image, or too small", async () => {
    const page = `<meta property="og:type" content="product"><meta property="og:title" content="Polo">
      <meta property="og:image" content="/missing.jpg"><meta property="og:image" content="/tiny.png"><meta property="og:image" content="/good.png">`;
    server.routes.set("shop.example/polo", html(page));
    server.routes.set("shop.example/tiny.png", bytes((await phonePng({ width: MIN_PRODUCT_IMAGE_PX - 1, height: 400 })).data, "image/png"));
    server.routes.set("shop.example/good.png", bytes((await phonePng({ width: 600, height: 600 })).data, "image/png"));
    const result = expectOk(await run("http://shop.example/polo"));
    expect(result.originalImageKey.endsWith(".png")).toBe(true);
    expect(server.requests.map((r) => r.path)).toEqual(["/polo", "/missing.jpg", "/tiny.png", "/good.png"]);
  });
});

describe("fallbacks: needs_screenshot", () => {
  async function expectFallback(url: string, reason: string) {
    const result = await run(url);
    expect(result).toMatchObject({ status: "needs_screenshot", reason, sourceUrl: url });
    if (result.status === "needs_screenshot") expect(result.message).toMatch(/screenshot/i);
    // Nothing stored, nothing recorded.
    expect(deps.storage.objects.size).toBe(0);
    expect(deps.linkImports.rows.size).toBe(0);
    return result;
  }

  it("fetch_blocked: the site refuses bots (403)", async () => {
    server.routes.set("shop.example/p", (_req, res) => res.writeHead(403, { "content-type": "text/html" }).end("Access denied"));
    await expectFallback("http://shop.example/p", "fetch_blocked");
  });

  it("fetch_blocked: the site doesn't exist", async () => {
    await expectFallback("http://no-such-shop.example/p", "fetch_blocked");
  });

  it("fetch_blocked: a private-network URL is refused without any request", async () => {
    for (const url of ["http://127.0.0.1/", "http://169.254.169.254/latest/meta-data/", "http://[::1]/", "http://192.168.1.1/admin", "http://localhost/"]) {
      await expectFallback(url, "fetch_blocked");
    }
    expect(server.requests).toEqual([]);
    expect(network.dialed).toEqual([]);
  });

  it("fetch_blocked: a public page that redirects to a private address", async () => {
    server.routes.set("shop.example/p", redirect("http://169.254.169.254/latest/meta-data/"));
    await expectFallback("http://shop.example/p", "fetch_blocked");
    expect(server.requests.map((r) => r.path)).toEqual(["/p"]);
  });

  it("fetch_blocked: a non-standard port", async () => {
    await expectFallback("http://shop.example:8080/p", "fetch_blocked");
  });

  it("fetch_blocked: a huge page (over 2 MB)", async () => {
    const huge = `<html><head><meta property="og:type" content="product"><meta property="og:title" content="Big"></head><body>${"x".repeat(2.5 * 1024 * 1024)}</body></html>`;
    server.routes.set("shop.example/huge", html(huge));
    await expectFallback("http://shop.example/huge", "fetch_blocked");
  });

  it("fetch_blocked: not an HTML page (PDF, JSON, an image)", async () => {
    server.routes.set("shop.example/catalogue.pdf", bytes(new TextEncoder().encode("%PDF-1.7"), "application/pdf"));
    server.routes.set("shop.example/api.json", bytes(new TextEncoder().encode("{}"), "application/json"));
    server.routes.set("shop.example/photo.jpg", bytes(productJpeg, "image/jpeg"));
    await expectFallback("http://shop.example/catalogue.pdf", "fetch_blocked");
    await expectFallback("http://shop.example/api.json", "fetch_blocked");
    await expectFallback("http://shop.example/photo.jpg", "fetch_blocked");
  });

  it("no_product_data: an article, or an empty page", async () => {
    server.routes.set("blog.example/white-shirt", html(fixture("no-product.html")));
    server.routes.set("shop.example/empty", html(""));
    await expectFallback("http://blog.example/white-shirt", "no_product_data");
    await expectFallback("http://shop.example/empty", "no_product_data");
  });

  it("no_image: product data but no image URL", async () => {
    server.routes.set("ashby.example/skirt", html(fixture("missing-image.html")));
    await expectFallback("http://ashby.example/skirt", "no_image");
  });

  it("no_image: the image URLs point at private addresses (checked like the page)", async () => {
    const page = `<meta property="og:type" content="product"><meta property="og:title" content="Shirt">
      <meta property="og:image" content="http://169.254.169.254/latest/meta-data/"><meta property="og:image" content="http://evil-cdn.example/a.jpg">
      <meta property="og:image" content="http://shop.example:8080/a.jpg">`;
    server.routes.set("shop.example/p", html(page));
    await expectFallback("http://shop.example/p", "no_image");
    expect(server.requests.map((r) => r.path)).toEqual(["/p"]);
  });

  it("no_image: an image that redirects to a private address", async () => {
    server.routes.set("shop.example/p", html(`<meta property="og:type" content="product"><meta property="og:image" content="/img.jpg">`));
    server.routes.set("shop.example/img.jpg", redirect("http://127.0.0.1/secret.jpg"));
    await expectFallback("http://shop.example/p", "no_image");
  });

  it("no_image: images that aren't JPEG, PNG or WebP (GIF, SVG, HTML, AVIF-labelled junk)", async () => {
    const gif = await sharp({ create: { width: 300, height: 300, channels: 3, background: "#123456" } }).gif().toBuffer();
    const svg = new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg" width="500" height="500"><rect width="500" height="500"/></svg>`);
    const page = `<meta property="og:type" content="product"><meta property="og:image" content="/a.gif"><meta property="og:image" content="/b.svg"><meta property="og:image" content="/c.avif">`;
    server.routes.set("shop.example/p", html(page));
    server.routes.set("shop.example/a.gif", bytes(new Uint8Array(gif), "image/gif"));
    server.routes.set("shop.example/b.svg", bytes(svg, "image/svg+xml"));
    server.routes.set("shop.example/c.avif", bytes(new TextEncoder().encode("<html>not an image</html>"), "image/avif"));
    await expectFallback("http://shop.example/p", "no_image");
  });

  it("no_image: a truncated JPEG that only fails when decoded", async () => {
    const truncated = productJpeg.slice(0, Math.floor(productJpeg.length / 3));
    server.routes.set("shop.example/p", html(`<meta property="og:type" content="product"><meta property="og:image" content="/t.jpg">`));
    server.routes.set("shop.example/t.jpg", bytes(truncated, "image/jpeg"));
    await expectFallback("http://shop.example/p", "no_image");
  });

  it("no_image: an image over 10 MB is cut off", async () => {
    const big = new Uint8Array(11 * 1024 * 1024);
    big.set(productJpeg.subarray(0, 4));
    server.routes.set("shop.example/p", html(`<meta property="og:type" content="product"><meta property="og:image" content="/big.jpg">`));
    server.routes.set("shop.example/big.jpg", (_req, res) => {
      // No Content-Length, so the cap has to trip while streaming.
      res.writeHead(200, { "content-type": "image/jpeg" });
      res.end(Buffer.from(big));
    });
    await expectFallback("http://shop.example/p", "no_image");
  });

  it("no_image: a decompression bomb (a small file claiming huge dimensions)", async () => {
    const bomb = await sharp({ create: { width: 10_000, height: 10_000, channels: 3, background: "#ffffff" } }).png({ compressionLevel: 9 }).toBuffer();
    expect(bomb.length).toBeLessThan(10 * 1024 * 1024);
    server.routes.set("shop.example/p", html(`<meta property="og:type" content="product"><meta property="og:image" content="/bomb.png">`));
    server.routes.set("shop.example/bomb.png", bytes(new Uint8Array(bomb), "image/png"));
    await expectFallback("http://shop.example/p", "no_image");
  });
});

describe("caps", () => {
  it("refuses at today's item cap before fetching anything", async () => {
    for (let i = 0; i < TEST_LIMITS.dailyCaps.item_ingest; i++) await deps.usage.recordAction(TEST_USER, "item_ingest");
    await expect(importFromLink(deps, TEST_USER, "http://shop.example/p")).rejects.toMatchObject({ cap: "items_per_day" });
    expect(server.requests).toEqual([]);
  });

  it("refuses when AI is paused for the month", async () => {
    await deps.usage.recordAiCost(null, "tagging", TEST_LIMITS.monthlySpendCapPence);
    await expect(importFromLink(deps, TEST_USER, "http://shop.example/p")).rejects.toBeInstanceOf(CapReachedError);
    expect(server.requests).toEqual([]);
  });
});

describe("step 1 rate limit (link imports in the last 24 h)", () => {
  function shop() {
    server.routes.set("shop.example/p", html(`<meta property="og:type" content="product"><meta property="og:image" content="/i.jpg">`));
    server.routes.set("shop.example/i.jpg", bytes(productJpeg, "image/jpeg"));
  }

  it("defaults to twice the daily item cap", () => {
    expect(LINK_IMPORTS_PER_DAY).toBe(2 * DAILY_CAPS.item_ingest);
    expect(LINK_IMPORTS_PER_DAY).toBe(80);
  });

  it("refuses above the limit with daily_cap_reached (items_per_day), before fetching anything", async () => {
    shop();
    const deps2 = { ...deps, linkImportsPerDay: 2 };
    const first = deps.clock();
    expectOk(await importFromLink(deps2, TEST_USER, "http://shop.example/p"));
    deps.advance(60_000);
    expectOk(await importFromLink(deps2, TEST_USER, "http://shop.example/p"));
    const requestsBefore = server.requests.length;

    const error = await importFromLink(deps2, TEST_USER, "http://shop.example/p").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiException);
    const api = error as ApiException;
    expect(api.code).toBe("daily_cap_reached");
    // The oldest counted import leaves the window first.
    expect(api.extras.cap).toEqual({ kind: "items_per_day", limit: 2, resetsAt: new Date(first.getTime() + LINK_IMPORT_WINDOW_MS).toISOString() });
    expect(server.requests.length).toBe(requestsBefore);
    // The contract's error shape accepts it.
    expect(ApiErrorSchema.safeParse({ error: { code: api.code, message: api.message, ...api.extras } }).success).toBe(true);
  });

  it("is a rolling 24 hours, per user", async () => {
    shop();
    const deps2 = { ...deps, linkImportsPerDay: 1 };
    expectOk(await importFromLink(deps2, TEST_USER, "http://shop.example/p"));
    await expect(importFromLink(deps2, TEST_USER, "http://shop.example/p")).rejects.toMatchObject({ code: "daily_cap_reached" });
    // Someone else isn't affected.
    expectOk(await importFromLink(deps2, OTHER_USER, "http://shop.example/p"));
    // A day later it's free again.
    deps.advance(LINK_IMPORT_WINDOW_MS + 1);
    expectOk(await importFromLink(deps2, TEST_USER, "http://shop.example/p"));
  });

  it("fallbacks don't create rows, so they don't count", async () => {
    server.routes.set("shop.example/blocked", (_req, res) => res.writeHead(403).end());
    const deps2 = { ...deps, linkImportsPerDay: 1 };
    for (let i = 0; i < 3; i++) expect((await importFromLink(deps2, TEST_USER, "http://shop.example/blocked")).status).toBe("needs_screenshot");
  });
});

describe("storage failures", () => {
  it("removes the stored image if the import can't be recorded", async () => {
    server.routes.set("shop.example/p", html(`<meta property="og:type" content="product"><meta property="og:image" content="/i.jpg">`));
    server.routes.set("shop.example/i.jpg", bytes(productJpeg, "image/jpeg"));
    vi.spyOn(deps.linkImports, "create").mockRejectedValueOnce(new Error("db down"));
    await expect(importFromLink(deps, TEST_USER, "http://shop.example/p")).rejects.toThrow("db down");
    expect(deps.storage.objects.size).toBe(0);
  });
});
