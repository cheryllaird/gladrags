/**
 * QA (round 2, P2): the picked-product picture fetcher with the REAL safe
 * fetcher and REAL sharp, against a local https server with a throwaway
 * certificate (trusted through the test-only NetworkDeps.tls). A fake DNS
 * maps the shop's hosts; nothing leaves the machine. Plus the generated-image
 * checks (inspectGeneratedImage) and storage encoding on hostile input.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import type { IncomingMessage, ServerResponse } from "node:http";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PREVIEW_STORED_MAX_BYTES, checkGeneratedPreviewImage, type ShopProduct } from "@/contracts";
import { inspectGeneratedImage } from "@/lib/images/preview-check";
import { SharpImageProcessor } from "@/lib/images/sharp-processor";
import type { NetworkDeps, ResolvedAddress } from "@/lib/link-import/safe-fetch";
import { PUBLIC_V4 } from "@/lib/link-import/test-support";
import { SafeFetchProductImageFetcher, encodePreviewForStorage } from "./preview-image";

function hasOpenssl(): boolean {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function jpeg(width: number, height: number) {
  return new Uint8Array(await sharp({ create: { width, height, channels: 3, background: { r: 250, g: 250, b: 250 } } }).jpeg().toBuffer());
}

async function png(width: number, height: number) {
  return new Uint8Array(await sharp({ create: { width, height, channels: 3, background: { r: 240, g: 238, b: 235 } } }).png().toBuffer());
}

/** A tiny valid PNG whose header claims a huge size (CRC fixed). */
function pngClaimingSize(data: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(data);
  const view = new DataView(out.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  view.setUint32(29, crc32(out.subarray(12, 29)));
  return out;
}

const PRODUCT: ShopProduct = {
  shopId: "next",
  title: "White leather trainers",
  url: "https://www.next.co.uk/style/st123",
  priceText: "£30",
  imageUrl: "https://www.next.co.uk/images/trainers.jpg",
};

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

describe.runIf(hasOpenssl())("QA SafeFetchProductImageFetcher, real safeFetch over local https", () => {
  let dir: string;
  let server: https.Server;
  let port: number;
  let ca: Buffer;
  const routes = new Map<string, Handler>();
  const requests: string[] = [];
  let dns: Map<string, string[]>;
  let dialed: ResolvedAddress[];
  const sockets = new Set<import("node:stream").Duplex>();

  const network = (): NetworkDeps => ({
    async resolve(hostname) {
      const addresses = dns.get(hostname);
      if (!addresses) throw new Error(`ENOTFOUND ${hostname}`);
      return addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
    },
    dial(address) {
      dialed.push(address);
      return { address: "127.0.0.1", family: 4, port };
    },
    tls: { ca },
  });

  const fetcher = () => new SafeFetchProductImageFetcher(new SharpImageProcessor(), network());

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "gladrags-qa-preview-tls-"));
    execFileSync(
      "openssl",
      [
        "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
        "-subj", "/CN=www.next.co.uk",
        "-addext", "subjectAltName=DNS:www.next.co.uk,DNS:cdn.next.co.uk,DNS:evil.example,DNS:www.zara.com",
        "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"),
      ],
      { stdio: "ignore" },
    );
    ca = readFileSync(join(dir, "c.pem"));
    server = https.createServer({ key: readFileSync(join(dir, "k.pem")), cert: ca }, (req, res) => {
      const host = (req.headers.host ?? "").replace(/:\d+$/, "");
      requests.push(`${host}${req.url ?? ""}`);
      const handler = routes.get(`${host}${req.url ?? ""}`);
      if (handler) return handler(req, res);
      res.writeHead(404).end();
    });
    server.on("connection", (s) => {
      sockets.add(s);
      s.on("close", () => sockets.delete(s));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    for (const s of sockets) s.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    routes.clear();
    requests.length = 0;
    dialed = [];
    dns = new Map([
      ["www.next.co.uk", [PUBLIC_V4]],
      ["cdn.next.co.uk", [PUBLIC_V4]],
      ["evil.example", [PUBLIC_V4]],
      ["www.zara.com", [PUBLIC_V4]],
    ]);
  });

  const serve = (path: string, body: Uint8Array | string, type: string): Handler => {
    const handler: Handler = (_req, res) => res.writeHead(200, { "content-type": type }).end(body);
    routes.set(path, handler);
    return handler;
  };
  const redirectTo = (path: string, location: string) => routes.set(path, (_req, res) => res.writeHead(302, { location }).end());

  it("fetches a good picture from the shop's own host and returns a model-ready JPEG", async () => {
    serve("www.next.co.uk/images/trainers.jpg", await jpeg(600, 800), "image/jpeg");
    const image = await fetcher().fetch(PRODUCT, 8_000);
    expect(image?.mimeType).toBe("image/jpeg");
    const meta = await sharp(image!.data).metadata();
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(768);
  });

  it("follows a redirect to another host on the shop's domain", async () => {
    redirectTo("www.next.co.uk/images/trainers.jpg", "https://cdn.next.co.uk/t.jpg");
    serve("cdn.next.co.uk/t.jpg", await jpeg(600, 800), "image/jpeg");
    expect(await fetcher().fetch(PRODUCT, 8_000)).not.toBeNull();
  });

  it.each(["https://evil.example/t.jpg", "https://www.zara.com/t.jpg", "http://cdn.next.co.uk/t.jpg"])("a redirect off the shop (%s): null, and the target is never requested", async (target) => {
    redirectTo("www.next.co.uk/images/trainers.jpg", target);
    serve("evil.example/t.jpg", await jpeg(600, 800), "image/jpeg");
    serve("www.zara.com/t.jpg", await jpeg(600, 800), "image/jpeg");
    expect(await fetcher().fetch(PRODUCT, 8_000)).toBeNull();
    expect(requests).toEqual(["www.next.co.uk/images/trainers.jpg"]);
  });

  it.each(["10.0.0.5", "127.0.0.1", "169.254.169.254", "::1", "fd00::1"])("the shop's host resolving to a private address (%s): null, never connected", async (address) => {
    dns.set("www.next.co.uk", [address]);
    serve("www.next.co.uk/images/trainers.jpg", await jpeg(600, 800), "image/jpeg");
    expect(await fetcher().fetch(PRODUCT, 8_000)).toBeNull();
    expect(dialed).toEqual([]);
    expect(requests).toEqual([]);
  });

  it("a redirect to a shop host that resolves privately: null, never connected to it", async () => {
    dns.set("cdn.next.co.uk", ["192.168.1.1"]);
    redirectTo("www.next.co.uk/images/trainers.jpg", "https://cdn.next.co.uk/t.jpg");
    expect(await fetcher().fetch(PRODUCT, 8_000)).toBeNull();
    expect(dialed).toHaveLength(1);
  });

  it("an oversize picture (over 10 MB): null", async () => {
    const big = new Uint8Array(10 * 1024 * 1024 + 10);
    big.set([0xff, 0xd8, 0xff, 0xe0]);
    serve("www.next.co.uk/images/trainers.jpg", big, "image/jpeg");
    expect(await fetcher().fetch(PRODUCT, 8_000)).toBeNull();
  });

  it("an HTML page instead of a picture: null", async () => {
    serve("www.next.co.uk/images/trainers.jpg", "<html>bot wall</html>", "text/html");
    expect(await fetcher().fetch(PRODUCT, 8_000)).toBeNull();
  });

  it("an SVG served as an image: null", async () => {
    serve("www.next.co.uk/images/trainers.jpg", '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800"/>', "image/svg+xml");
    expect(await fetcher().fetch(PRODUCT, 8_000)).toBeNull();
  });

  it("a GIF: null (only JPEG, PNG and WebP are sent)", async () => {
    serve("www.next.co.uk/images/trainers.jpg", new Uint8Array(await sharp({ create: { width: 300, height: 300, channels: 3, background: "#fff" } }).gif().toBuffer()), "image/gif");
    expect(await fetcher().fetch(PRODUCT, 8_000)).toBeNull();
  });

  it("a picture under 100 px: null", async () => {
    serve("www.next.co.uk/images/trainers.jpg", await jpeg(80, 400), "image/jpeg");
    expect(await fetcher().fetch(PRODUCT, 8_000)).toBeNull();
  });

  it("a truncated JPEG: null", async () => {
    const full = await jpeg(600, 800);
    serve("www.next.co.uk/images/trainers.jpg", full.subarray(0, Math.floor(full.byteLength / 2)), "image/jpeg");
    expect(await fetcher().fetch(PRODUCT, 8_000)).toBeNull();
  });

  it("a decompression bomb by header: null or a rejection the preview turns into words, never a decode", async () => {
    serve("www.next.co.uk/images/trainers.jpg", pngClaimingSize(await png(4, 6), 60_000, 60_000), "image/png");
    const result = await fetcher().fetch(PRODUCT, 8_000).catch((error: unknown) => error);
    expect(result === null || result instanceof Error).toBe(true);
  });

  it("a slow server: null within the time given", async () => {
    routes.set("www.next.co.uk/images/trainers.jpg", (_req, res) => {
      res.writeHead(200, { "content-type": "image/jpeg" });
      res.write(new Uint8Array([0xff, 0xd8, 0xff])); // then nothing
    });
    const started = Date.now();
    expect(await fetcher().fetch(PRODUCT, 600)).toBeNull();
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("no time left: null without a request", async () => {
    serve("www.next.co.uk/images/trainers.jpg", await jpeg(600, 800), "image/jpeg");
    expect(await fetcher().fetch(PRODUCT, 0)).toBeNull();
    expect(await fetcher().fetch(PRODUCT, -5)).toBeNull();
    expect(requests).toEqual([]);
  });
});

describe("QA inspectGeneratedImage + checkGeneratedPreviewImage on hostile replies", () => {
  const check = async (data: Uint8Array) => checkGeneratedPreviewImage(await inspectGeneratedImage(data));

  it("a good 832 x 1248 PNG passes", async () => {
    expect(await check(await png(832, 1248))).toEqual({ ok: true });
  });

  it.each([
    ["an SVG", () => Promise.resolve(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="832" height="1248"/>'))],
    ["a GIF", async () => new Uint8Array(await sharp({ create: { width: 832, height: 1248, channels: 3, background: "#fff" } }).gif().toBuffer())],
    ["a TIFF", async () => new Uint8Array(await sharp({ create: { width: 832, height: 1248, channels: 3, background: "#fff" } }).tiff().toBuffer())],
    ["a truncated PNG", async () => (await png(832, 1248)).subarray(0, 300)],
    ["a decompression bomb by header", async () => pngClaimingSize(await png(4, 6), 40_000, 60_000)],
    ["a header just over the pixel limit (4097 x 4097)", async () => pngClaimingSize(await png(4, 6), 4097, 4097)],
    ["no bytes", () => Promise.resolve(new Uint8Array(0))],
  ])("%s fails", async (_n, make) => {
    const result = await check(await make());
    expect(result.ok).toBe(false);
  });

  it("a bomb by header isn't decoded (answers fast)", async () => {
    const started = Date.now();
    const facts = await inspectGeneratedImage(pngClaimingSize(await png(4, 6), 40_000, 60_000));
    expect(facts.dimensions).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("encodePreviewForStorage refuses a bomb by header instead of allocating it", async () => {
    await expect(encodePreviewForStorage(pngClaimingSize(await png(4, 6), 40_000, 60_000))).rejects.toThrow();
  });

  it("encodePreviewForStorage keeps a noisy 4096-high picture under the stored size limit, exactly 2:3", async () => {
    const width = 2730;
    const height = 4096;
    const noise = new Uint8Array(width * height * 3);
    for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761) >>> 24;
    const data = new Uint8Array(await sharp(noise, { raw: { width, height, channels: 3 } }).png({ compressionLevel: 1 }).toBuffer());
    const result = await encodePreviewForStorage(data).catch((e: Error) => e);
    // Either stored within the limit, or refused (the preview then fails as internal); never over the limit.
    if (result instanceof Error) {
      expect(result.message).toMatch(/too big/);
    } else {
      expect(result.data.byteLength).toBeLessThanOrEqual(PREVIEW_STORED_MAX_BYTES);
      const meta = await sharp(result.data).metadata();
      expect(meta.width! * 3).toBe(meta.height! * 2);
    }
  }, 30_000);

  it("encodePreviewForStorage flattens transparency (no alpha in the stored WebP)", async () => {
    const rgba = new Uint8Array(await sharp({ create: { width: 832, height: 1248, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer());
    const stored = await encodePreviewForStorage(rgba);
    expect((await sharp(stored.data).metadata()).hasAlpha).toBe(false);
  });
});
