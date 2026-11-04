/**
 * QA (milestone 5, C4): the real product page checker (SafeFetchShopPageChecker)
 * against local servers standing in for the shops. Real https with a
 * certificate made here; a fake DNS maps shop names to public-looking
 * addresses and every connection goes to localhost. No real network.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ShopId } from "@/contracts";
import { PUBLIC_V4, PUBLIC_V4_B, startTestServer, testNetwork, type TestServer } from "@/lib/link-import/test-support";
import type { NetworkDeps, ResolvedAddress } from "@/lib/link-import/safe-fetch";
import { SafeFetchShopPageChecker } from "./shop-pages";

function hasOpenssl(): boolean {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

type Route = (req: IncomingMessage, res: ServerResponse) => void;

const HOSTS = ["www.next.co.uk", "www.marksandspencer.com", "www.zara.com", "evil.example", "internal.next.co.uk", "media.next.co.uk"];

const productPage = (extra = "", ld: object = { "@type": "Product", name: "White Leather Trainers", image: "https://xcdn.next.co.uk/t.jpg", offers: { price: "45.00", priceCurrency: "GBP" } }) =>
  `<!doctype html><html><head><meta property="og:type" content="product"><meta property="og:title" content="White Leather Trainers">` +
  `<script type="application/ld+json">${JSON.stringify(ld)}</script>${extra}</head><body>ok</body></html>`;

describe.runIf(hasOpenssl())("SafeFetchShopPageChecker over https", () => {
  let dir: string;
  let cert: Buffer;
  let tls: https.Server;
  let tlsPort: number;
  let plain: TestServer;
  const routes = new Map<string, Route>();
  const hits: string[] = [];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "gladrags-qa-shop-tls-"));
    execFileSync(
      "openssl",
      [
        "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
        "-subj", "/CN=www.next.co.uk",
        "-addext", `subjectAltName=${HOSTS.map((h) => `DNS:${h}`).join(",")}`,
        "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"),
      ],
      { stdio: "ignore" },
    );
    cert = readFileSync(join(dir, "cert.pem"));
    tls = https.createServer({ key: readFileSync(join(dir, "key.pem")), cert }, (req, res) => {
      const key = `${(req.headers.host ?? "").replace(/:\d+$/, "")}${req.url ?? "/"}`;
      hits.push(key);
      const route = routes.get(key);
      if (route) return route(req, res);
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    });
    await new Promise<void>((resolve) => tls.listen(0, "127.0.0.1", resolve));
    tlsPort = (tls.address() as AddressInfo).port;
    plain = await startTestServer();
  });

  afterAll(async () => {
    tls.closeAllConnections();
    await new Promise<void>((resolve) => tls.close(() => resolve()));
    await plain.close();
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    routes.clear();
    hits.length = 0;
    plain.routes.clear();
    plain.requests.length = 0;
  });

  function network(): NetworkDeps & { dialed: ResolvedAddress[] } {
    const base = testNetwork(plain.port, {
      "www.next.co.uk": [PUBLIC_V4],
      "media.next.co.uk": [PUBLIC_V4],
      "www.marksandspencer.com": [PUBLIC_V4],
      "www.zara.com": [PUBLIC_V4_B],
      "evil.example": [PUBLIC_V4_B],
      "internal.next.co.uk": ["10.0.0.5"],
      "metadata.next.co.uk": ["169.254.169.254"],
    });
    return Object.assign(base, {
      tls: { ca: cert },
      dial(address: ResolvedAddress, port: number) {
        base.dialed.push(address);
        return { address: "127.0.0.1", family: 4 as const, port: port === 443 ? tlsPort : plain.port };
      },
    });
  }

  const check = (url: string, shopId: ShopId = "next", timeoutMs = 5_000, net = network()) =>
    new SafeFetchShopPageChecker(net).check({ url, shopId, title: "Model's title, never shown" }, timeoutMs);
  const page = (body: string, headers: Record<string, string> = {}): Route => (_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", ...headers }).end(body);
  };
  const to = (location: string, status = 302): Route => (_req, res) => {
    res.writeHead(status, { location }).end();
  };

  it("a real product page: title, price and image from the page, not the model", async () => {
    routes.set("www.next.co.uk/p", page(productPage()));
    expect(await check("https://www.next.co.uk/p")).toEqual({
      shopId: "next",
      title: "White Leather Trainers",
      url: "https://www.next.co.uk/p",
      priceText: "£45",
      imageUrl: "https://xcdn.next.co.uk/t.jpg",
    });
  });

  it("a redirect within the shop keeps the final address", async () => {
    routes.set("www.next.co.uk/old", to("https://www.next.co.uk/new", 301));
    routes.set("www.next.co.uk/new", page(productPage()));
    expect((await check("https://www.next.co.uk/old"))?.url).toBe("https://www.next.co.uk/new");
  });

  it.each([
    ["off the shop", "https://evil.example/p"],
    ["to another shop", "https://www.zara.com/p"],
  ])("a redirect %s is dropped, and never followed", async (_label, target) => {
    routes.set("www.next.co.uk/p", to(target));
    routes.set(`${new URL(target).host}/p`, page(productPage()));
    expect(await check("https://www.next.co.uk/p")).toBeNull();
    // safeFetch's allowRedirect stops it before the off-shop host is fetched.
    expect(hits).toEqual(["www.next.co.uk/p"]);
  });

  it.each([
    ["a private address", "https://internal.next.co.uk/p", "10.0.0.5"],
    ["the cloud metadata address", "https://metadata.next.co.uk/latest", "169.254.169.254"],
    ["a literal private IP", "https://10.1.2.3/p", "10.1.2.3"],
    ["a literal loopback", "https://127.0.0.1/p", "127.0.0.1"],
  ])("a redirect to %s is refused before connecting", async (_label, target, address) => {
    routes.set("www.next.co.uk/p", to(target));
    const net = network();
    expect(await check("https://www.next.co.uk/p", "next", 5_000, net)).toBeNull();
    expect(net.dialed.map((d) => d.address)).not.toContain(address);
    expect(hits).toEqual(["www.next.co.uk/p"]);
  });

  it("an https -> http redirect on the shop itself is refused", async () => {
    routes.set("www.next.co.uk/p", to("http://www.next.co.uk/p"));
    plain.routes.set("www.next.co.uk/p", page(productPage()));
    expect(await check("https://www.next.co.uk/p")).toBeNull();
    expect(plain.requests).toEqual([]);
  });

  it("more than 3 redirects is dropped", async () => {
    for (let i = 0; i < 5; i++) routes.set(`www.next.co.uk/r${i}`, to(`https://www.next.co.uk/r${i + 1}`));
    routes.set("www.next.co.uk/r5", page(productPage()));
    expect(await check("https://www.next.co.uk/r0")).toBeNull();
  });

  it("a page that never answers is given up within the time it was given", async () => {
    routes.set("www.next.co.uk/hang", () => {});
    const started = Date.now();
    expect(await check("https://www.next.co.uk/hang", "next", 400)).toBeNull();
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("a page that drips slowly is given up at the time budget", async () => {
    routes.set("www.next.co.uk/drip", (_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.write(productPage().slice(0, 40));
      const timer = setInterval(() => res.write(" "), 100);
      res.on("close", () => clearInterval(timer));
    });
    const started = Date.now();
    expect(await check("https://www.next.co.uk/drip", "next", 600)).toBeNull();
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("a huge page (over 2 MB) is dropped", async () => {
    routes.set("www.next.co.uk/huge", (_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(productPage() + "<!--" + "x".repeat(3 * 1024 * 1024) + "-->");
    });
    expect(await check("https://www.next.co.uk/huge", "next", 8_000)).toBeNull();
  });

  it("a page that isn't HTML is dropped", async () => {
    routes.set("www.next.co.uk/img", page(productPage(), { "content-type": "image/png" }));
    expect(await check("https://www.next.co.uk/img")).toBeNull();
  });

  it("injected JSON-LD and Open Graph claiming another address: the product keeps the page's own address", async () => {
    const extra =
      '<meta property="og:url" content="https://evil.example/buy-here">' +
      '<link rel="canonical" href="https://evil.example/canonical">';
    routes.set(
      "www.next.co.uk/p",
      page(productPage(extra, { "@type": "Product", name: "Trainers", url: "https://evil.example/ld", offers: { price: "45", priceCurrency: "GBP", url: "https://evil.example/offer" } })),
    );
    const found = await check("https://www.next.co.uk/p");
    expect(found?.url).toBe("https://www.next.co.uk/p");
    expect(JSON.stringify(found)).not.toContain("evil.example");
  });

  it("injected prices that aren't numbers are ignored; meta price is a fallback", async () => {
    const meta = '<meta property="product:price:amount" content="39.99"><meta property="product:price:currency" content="GBP">';
    routes.set(
      "www.next.co.uk/p",
      page(productPage(meta, { "@type": "Product", name: "Trainers", offers: { price: "FREE! click https://evil.example", priceCurrency: "GBP" } })),
    );
    expect((await check("https://www.next.co.uk/p"))?.priceText).toBe("£39.99");
  });

  it("a negative or absurd price isn't shown", async () => {
    routes.set("www.next.co.uk/p", page(productPage("", { "@type": "Product", name: "Trainers", offers: { price: -5, priceCurrency: "GBP" } })));
    expect((await check("https://www.next.co.uk/p"))?.priceText).toBeNull();
    routes.set("www.next.co.uk/q", page(productPage("", { "@type": "Product", name: "Trainers", offers: { price: "1e9", priceCurrency: "GBP" } })));
    expect((await check("https://www.next.co.uk/q"))?.priceText).toBeNull();
  });

  it("a title stuffed with line breaks and bidi controls is flattened and cleaned", async () => {
    routes.set("www.next.co.uk/p", page(productPage("", { "@type": "Product", name: "Trainers\n‮gnp.exe‬\tNow", offers: { price: "10", priceCurrency: "GBP" } })));
    const found = await check("https://www.next.co.uk/p");
    expect(found?.title).not.toMatch(/[\n\t‮‬]/);
    expect(found?.title).toContain("Trainers");
  });

  // Observation (not a code bug): the product picture can be on any https
  // host the shop's page names. Shown on the product card only (decision 6),
  // so the shop's page decides which server the phone loads it from.
  it("an image on another https host is kept as the page gives it", async () => {
    routes.set("www.next.co.uk/p", page(productPage("", { "@type": "Product", name: "Trainers", image: "https://evil.example/pixel.png" })));
    expect((await check("https://www.next.co.uk/p"))?.imageUrl).toBe("https://evil.example/pixel.png");
  });
});
