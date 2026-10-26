/**
 * QA: add by link, step 1, adversarially. Caps and the AI pause come before
 * any DNS lookup or fetch; every fallback reason lands on the screenshot
 * path with nothing stored, recorded, tagged or counted; image URLs found in
 * a page get the same SSRF checks as the page; image bombs and endless
 * image lists are bounded.
 */
import { crc32 } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LinkImportResponseSchema, type LinkImportResponse } from "@/contracts";
import { CapReachedError } from "@/lib/usage/errors";
import { TEST_LIMITS, TEST_USER } from "@/test/ingestion-deps";
import { phoneJpeg } from "@/test/images";
import { MAX_IMAGE_ATTEMPTS, importFromLink } from "./import-link";
import { PUBLIC_V4, PUBLIC_V6, bytes, html, makeLinkDeps, redirect, startTestServer, testNetwork, type TestNetwork, type TestServer } from "./test-support";

let server: TestServer;
let network: TestNetwork;
let deps: ReturnType<typeof makeLinkDeps>;
let productJpeg: Uint8Array;

beforeEach(async () => {
  server = await startTestServer();
  network = testNetwork(server.port, {
    "shop.example": [PUBLIC_V4],
    "cdn.shop.example": [PUBLIC_V4],
    "v6cdn.shop.example": [PUBLIC_V6],
    "rebind.attacker.example": [PUBLIC_V4],
    "private-v6.attacker.example": ["fd00::10"],
    "mixed.attacker.example": [PUBLIC_V4, "10.0.0.7"],
  });
  deps = makeLinkDeps(network);
  productJpeg = (await phoneJpeg({ width: 800, height: 1000 })).data;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  await server.close();
  vi.restoreAllMocks();
});

const PRODUCT_HEAD = `<meta property="og:type" content="product"><meta property="og:title" content="Wool Coat">`;

function productPage(images: string[]): string {
  return PRODUCT_HEAD + images.map((src) => `<meta property="og:image" content="${src}">`).join("");
}

async function run(url: string): Promise<LinkImportResponse> {
  return LinkImportResponseSchema.parse(await importFromLink(deps, TEST_USER, url));
}

/** The screenshot fallback, with nothing stored, recorded, tagged or counted. */
async function expectFallback(url: string, reason: "fetch_blocked" | "no_product_data" | "no_image") {
  const result = await run(url);
  expect(result).toMatchObject({ status: "needs_screenshot", reason, sourceUrl: url });
  expect(deps.storage.objects.size).toBe(0);
  expect(deps.linkImports.rows.size).toBe(0);
  expect(deps.fakeTagger.calls).toHaveLength(0);
  const summary = await deps.usage.summary(TEST_USER);
  expect(summary.itemsToday.used).toBe(0);
  return result;
}

describe("caps and the AI pause come before any network use", () => {
  it("at today's item cap: refused with no DNS lookup and no request", async () => {
    for (let i = 0; i < TEST_LIMITS.dailyCaps.item_ingest; i++) await deps.usage.reserveAction(TEST_USER, "item_ingest");
    const error = await importFromLink(deps, TEST_USER, "http://shop.example/p").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CapReachedError);
    expect((error as CapReachedError).cap).toBe("items_per_day");
    expect(network.lookups).toEqual([]);
    expect(server.requests).toEqual([]);
  });

  it("AI paused: refused with no DNS lookup and no request, even for a link that would fall back", async () => {
    await deps.usage.recordAiCost(null, "tagging", TEST_LIMITS.monthlySpendCapPence);
    for (const url of ["http://shop.example/p", "http://127.0.0.1/", "ftp://shop.example/"]) {
      await expect(importFromLink(deps, TEST_USER, url)).rejects.toBeInstanceOf(CapReachedError);
    }
    expect(network.lookups).toEqual([]);
    expect(server.requests).toEqual([]);
  });

  it("one item short of the cap is still allowed, and step 1 doesn't use it up", async () => {
    for (let i = 0; i < TEST_LIMITS.dailyCaps.item_ingest - 1; i++) await deps.usage.reserveAction(TEST_USER, "item_ingest");
    server.routes.set("shop.example/p", html(productPage(["/i.jpg"])));
    server.routes.set("shop.example/i.jpg", bytes(productJpeg, "image/jpeg"));
    expect((await run("http://shop.example/p")).status).toBe("ok");
    expect((await run("http://shop.example/p")).status).toBe("ok");
    expect((await deps.usage.summary(TEST_USER)).itemsToday.used).toBe(TEST_LIMITS.dailyCaps.item_ingest - 1);
  });
});

describe("fetch_blocked: every way the page can't be fetched", () => {
  it.each<[string, (s: TestServer) => void, string]>([
    ["a 500", (s) => s.routes.set("shop.example/p", (_q, r) => r.writeHead(500).end()), "http://shop.example/p"],
    ["a 429 bot wall", (s) => s.routes.set("shop.example/p", (_q, r) => r.writeHead(429, { "retry-after": "60" }).end()), "http://shop.example/p"],
    ["a redirect to file:", (s) => s.routes.set("shop.example/p", redirect("file:///etc/passwd")), "http://shop.example/p"],
    ["a redirect to a non-default port", (s) => s.routes.set("shop.example/p", redirect("http://shop.example:8080/p")), "http://shop.example/p"],
    ["a redirect to //127.0.0.1", (s) => s.routes.set("shop.example/p", redirect("//127.0.0.1/p")), "http://shop.example/p"],
    ["a redirect loop", (s) => s.routes.set("shop.example/p", redirect("/p")), "http://shop.example/p"],
    ["a JSON response", (s) => s.routes.set("shop.example/p", (_q, r) => r.writeHead(200, { "content-type": "application/json" }).end("{}")), "http://shop.example/p"],
    ["an image instead of a page", (s) => s.routes.set("shop.example/p", (_q, r) => r.writeHead(200, { "content-type": "image/jpeg" }).end("x")), "http://shop.example/p"],
    ["a name with one private address", () => {}, "http://mixed.attacker.example/p"],
    ["a name resolving to private IPv6", () => {}, "http://private-v6.attacker.example/p"],
    ["userinfo pointing at loopback", () => {}, "http://shop.example@127.0.0.1/p"],
    ["an octal loopback", () => {}, "http://0177.0.0.1/p"],
    ["IPv4-mapped loopback", () => {}, "http://[::ffff:127.0.0.1]/p"],
  ])("%s", async (_label, setup, url) => {
    setup(server);
    await expectFallback(url, "fetch_blocked");
  });

  it("DNS rebinding between the page and its image: the image's new private answer is refused", async () => {
    server.routes.set("rebind.attacker.example/p", html(productPage(["http://rebind.attacker.example/i.jpg"])));
    server.routes.set("rebind.attacker.example/i.jpg", bytes(productJpeg, "image/jpeg"));
    const original = network.resolve.bind(network);
    let calls = 0;
    network.resolve = async (host) => (++calls === 1 ? original(host) : [{ address: "127.0.0.1", family: 4 }]);
    await expectFallback("http://rebind.attacker.example/p", "no_image");
    expect(server.requests.map((r) => r.path)).toEqual(["/p"]);
  });
});

describe("no_product_data", () => {
  it.each([
    ["a title but no image or product type", `<meta property="og:title" content="Hi">`],
    ["an image but no title or product type", `<meta property="og:image" content="/i.jpg">`],
    ["JSON-LD of a WebPage only", `<script type="application/ld+json">{"@type":"WebPage","name":"Shop","image":"/i.jpg"}</script>`],
    ["product data only inside <noscript>", `<noscript>${productPage(["/i.jpg"])}</noscript>`],
    ["binary junk served as text/html", "\u0000\u0001\u0002\uffff<\u0000meta"],
  ])("%s", async (_label, body) => {
    server.routes.set("shop.example/p", html(body));
    await expectFallback("http://shop.example/p", "no_product_data");
    // The image was never fetched.
    expect(server.requests.map((r) => r.path)).toEqual(["/p"]);
  });
});

describe("no_image: image URLs get the same SSRF checks as the page", () => {
  it.each([
    "http://[::1]/i.jpg",
    "http://[::]/i.jpg",
    "http://[::ffff:127.0.0.1]/i.jpg",
    "http://[::ffff:169.254.169.254]/i.jpg",
    "http://[fe80::1]/i.jpg",
    "http://[fd00::1]/i.jpg",
    "http://[64:ff9b::a9fe:a9fe]/i.jpg",
    "http://[2002:a9fe:a9fe::]/i.jpg",
    "http://2130706433/i.jpg",
    "http://0x7f.1/i.jpg",
    "//127.1/i.jpg",
    "http://localhost./i.jpg",
    "http://private-v6.attacker.example/i.jpg",
    "http://cdn.shop.example:8443/i.jpg",
    "http://user:pw@cdn.shop.example/i.jpg",
  ])("%s", async (src) => {
    server.routes.set("shop.example/p", html(productPage([src])));
    await expectFallback("http://shop.example/p", "no_image");
    expect(server.requests.map((r) => `${r.host}${r.path}`)).toEqual(["shop.example/p"]);
    expect(network.dialed.map((d) => d.address)).toEqual([PUBLIC_V4]);
  });

  it("a public IPv6 image host works", async () => {
    server.routes.set("shop.example/p", html(productPage(["http://v6cdn.shop.example/i.jpg"])));
    server.routes.set("v6cdn.shop.example/i.jpg", bytes(productJpeg, "image/jpeg"));
    expect((await run("http://shop.example/p")).status).toBe("ok");
    expect(network.dialed.map((d) => d.address)).toEqual([PUBLIC_V4, PUBLIC_V6]);
  });

  it("an image that redirects to a protocol-relative private host is refused", async () => {
    server.routes.set("shop.example/p", html(productPage(["/i.jpg"])));
    server.routes.set("shop.example/i.jpg", redirect("//[::1]/i.jpg", 308));
    await expectFallback("http://shop.example/p", "no_image");
  });

  it("the og:image pointing back at the HTML page is not an image", async () => {
    server.routes.set("shop.example/p", html(productPage(["/p"])));
    await expectFallback("http://shop.example/p", "no_image");
  });
});

describe("many images and image bombs", () => {
  it(`hundreds of og:image tags: at most ${MAX_IMAGE_ATTEMPTS} downloads are tried`, async () => {
    const images = Array.from({ length: 400 }, (_, i) => `/img/${i}.jpg`);
    server.routes.set("shop.example/p", html(productPage(images)));
    // Every image 404s.
    await expectFallback("http://shop.example/p", "no_image");
    const imageRequests = server.requests.filter((r) => r.path.startsWith("/img/"));
    expect(imageRequests.map((r) => r.path)).toEqual(["/img/0.jpg", "/img/1.jpg", "/img/2.jpg"].slice(0, MAX_IMAGE_ATTEMPTS));
  });

  it("the fourth image isn't tried even if it's the only good one", async () => {
    server.routes.set("shop.example/p", html(productPage(["/a.jpg", "/b.jpg", "/c.jpg", "/good.jpg"])));
    server.routes.set("shop.example/good.jpg", bytes(productJpeg, "image/jpeg"));
    await expectFallback("http://shop.example/p", "no_image");
  });

  it("a PNG whose header claims 60 000 × 60 000 pixels is refused without decoding it", async () => {
    server.routes.set("shop.example/p", html(productPage(["/bomb.png"])));
    server.routes.set("shop.example/bomb.png", bytes(hugePngHeader(60_000, 60_000), "image/png"));
    const started = Date.now();
    await expectFallback("http://shop.example/p", "no_image");
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("a JPEG whose frame header claims 65 000 × 65 000 pixels is refused", async () => {
    server.routes.set("shop.example/p", html(productPage(["/bomb.jpg"])));
    server.routes.set("shop.example/bomb.jpg", bytes(withJpegSize(productJpeg, 65_000, 65_000), "image/jpeg"));
    await expectFallback("http://shop.example/p", "no_image");
  });

  it("a bomb first and a good image second: the good one is used", async () => {
    server.routes.set("shop.example/p", html(productPage(["/bomb.png", "/ok.jpg"])));
    server.routes.set("shop.example/bomb.png", bytes(hugePngHeader(60_000, 60_000), "image/png"));
    server.routes.set("shop.example/ok.jpg", bytes(productJpeg, "image/jpeg"));
    expect((await run("http://shop.example/p")).status).toBe("ok");
  });
});

describe("what step 1 keeps", () => {
  it("the import keeps the URL the user pasted, not the redirect target, and nothing counts", async () => {
    server.routes.set("shop.example/short", redirect("http://cdn.shop.example/long/path?utm=1"));
    server.routes.set("cdn.shop.example/long/path?utm=1", html(productPage(["/i.jpg"])));
    server.routes.set("cdn.shop.example/i.jpg", bytes(productJpeg, "image/jpeg"));
    const result = await run("http://shop.example/short");
    expect(result.status).toBe("ok");
    expect([...deps.linkImports.rows.values()][0]!.sourceUrl).toBe("http://shop.example/short");
    expect(deps.fakeTagger.calls).toHaveLength(0);
    expect((await deps.usage.summary(TEST_USER)).itemsToday.used).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Image builders
// ---------------------------------------------------------------------------

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A tiny PNG whose IHDR declares a huge size; the pixel data is a few bytes of nothing. */
function hugePngHeader(width: number, height: number): Uint8Array {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const idat = chunk("IDAT", Buffer.from([0x78, 0x9c, 0x63, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01]));
  return new Uint8Array(Buffer.concat([signature, chunk("IHDR", ihdr), idat, chunk("IEND", Buffer.alloc(0))]));
}

/** A copy of a real JPEG with its SOF frame header's size rewritten. */
function withJpegSize(jpeg: Uint8Array, width: number, height: number): Uint8Array {
  const copy = Buffer.from(jpeg);
  for (let i = 2; i < copy.length - 9; ) {
    if (copy[i] !== 0xff) break;
    const marker = copy[i + 1]!;
    const length = copy.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xc3) {
      copy.writeUInt16BE(height, i + 5);
      copy.writeUInt16BE(width, i + 7);
      return new Uint8Array(copy);
    }
    i += 2 + length;
  }
  throw new Error("No SOF marker found");
}
