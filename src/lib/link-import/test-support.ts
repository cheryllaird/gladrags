/**
 * Test helpers for the link importer (not used by the app). No real
 * network: a local HTTP server stands in for every shop, and a fake DNS
 * maps made-up host names to addresses.
 *
 * The fake DNS returns realistic PUBLIC addresses, so the real address
 * checks run on them; `dial` then sends the actual connection to the local
 * server. A host mapped to a private address is refused before `dial` is
 * ever asked, exactly as in production.
 */
import { readFileSync } from "node:fs";
import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { FakeTaggingProvider } from "@/lib/ai/fakes";
import type { TaggingProvider } from "@/lib/ai/types";
import { SharpImageProcessor } from "@/lib/images/sharp-processor";
import { InMemoryItemRepository } from "@/lib/ingestion/items-repository";
import { InMemoryImageStorage, type ImageBucket } from "@/lib/ingestion/storage";
import type { ImageStore } from "@/lib/outfits/thumbnails";
import { UsageGuard } from "@/lib/usage/guard";
import { InMemoryUsageStore } from "@/lib/usage/store";
import { TEST_LIMITS } from "@/test/ingestion-deps";
import { InMemoryLinkImportRepository } from "./repository";
import type { NetworkDeps, ResolvedAddress } from "./safe-fetch";

export function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

export type Handler = (req: IncomingMessage, res: ServerResponse) => void;

export interface TestServer {
  port: number;
  /** Routes keyed by "host/path?query" (host without port). */
  routes: Map<string, Handler>;
  requests: { host: string; path: string; headers: IncomingHttpHeaders }[];
  close(): Promise<void>;
}

export async function startTestServer(): Promise<TestServer> {
  const routes = new Map<string, Handler>();
  const requests: TestServer["requests"] = [];
  const sockets = new Set<import("node:net").Socket>();
  const server = http.createServer((req, res) => {
    const host = (req.headers.host ?? "").replace(/:\d+$/, "");
    const path = req.url ?? "/";
    requests.push({ host, path, headers: req.headers });
    const handler = routes.get(`${host}${path}`);
    if (handler) return handler(req, res);
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    routes,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

export interface TestNetwork extends NetworkDeps {
  /** Every host name looked up, in order. */
  lookups: string[];
  /** Every vetted address a connection was opened for. */
  dialed: ResolvedAddress[];
  /** Change what a name resolves to (e.g. to simulate DNS rebinding). */
  dns: Map<string, string[]>;
}

/** A fake DNS (host -> addresses) whose connections all go to the local test server. */
export function testNetwork(port: number, dns: Record<string, string[]>): TestNetwork {
  const network: TestNetwork = {
    lookups: [],
    dialed: [],
    dns: new Map(Object.entries(dns)),
    async resolve(hostname) {
      network.lookups.push(hostname);
      const addresses = network.dns.get(hostname);
      if (!addresses) throw new Error(`ENOTFOUND ${hostname}`);
      return addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
    },
    dial(address) {
      network.dialed.push(address);
      return { address: "127.0.0.1", family: 4, port };
    },
  };
  return network;
}

/** Public-looking addresses for the fake DNS (real, routable ranges; never contacted). */
export const PUBLIC_V4 = "93.184.215.14";
export const PUBLIC_V4_B = "151.101.1.140";
export const PUBLIC_V6 = "2606:2800:21f:cb07:6820:80da:af6b:8b2c";

/**
 * Everything both link steps need, in memory: real sharp image processing,
 * in-memory storage, link imports and usage (from makeTestDeps), a fake
 * tagger, and the test network.
 */
export function makeLinkDeps(network: NetworkDeps, { taggerOutputs = [] as unknown[] } = {}) {
  let now = new Date("2026-10-25T10:00:00Z");
  const clock = () => now;
  const usageStore = new InMemoryUsageStore(clock);
  const storage = new InMemoryImageStorage(clock);
  const fakeTagger = new FakeTaggingProvider(taggerOutputs.length ? taggerOutputs : ["{}"]);
  const imageStore: ImageStore = {
    async download(ref) {
      const image = storage.get(ref.bucket as ImageBucket, ref.key);
      if (!image) throw new Error("Couldn't download image: not found");
      return image;
    },
  };
  return {
    images: new SharpImageProcessor(),
    storage,
    imageStore,
    items: new InMemoryItemRepository(clock),
    linkImports: new InMemoryLinkImportRepository(clock),
    tagger: fakeTagger as TaggingProvider,
    fakeTagger,
    usage: new UsageGuard(usageStore, TEST_LIMITS, clock),
    usageStore,
    network,
    clock,
    setNow: (iso: string) => (now = new Date(iso)),
    advance: (ms: number) => (now = new Date(now.getTime() + ms)),
  };
}

export function html(body: string, headers: Record<string, string> = {}): Handler {
  return (_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", ...headers }).end(body);
  };
}

export function bytes(data: Uint8Array, contentType: string): Handler {
  return (_req, res) => {
    res.writeHead(200, { "content-type": contentType, "content-length": String(data.byteLength) }).end(Buffer.from(data));
  };
}

export function redirect(location: string, status = 302, headers: Record<string, string> = {}): Handler {
  return (_req, res) => {
    res.writeHead(status, { location, ...headers }).end();
  };
}
