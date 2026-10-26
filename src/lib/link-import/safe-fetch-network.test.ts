/**
 * The fetcher's network edges, all local (no real network):
 * - every vetted address is pinned, so an unreachable IPv6 address falls
 *   back to IPv4 (Vercel's functions usually have no IPv6 route);
 * - real HTTPS with a certificate generated here: the right host name
 *   passes, a mismatched one is refused (SNI and host name checks);
 * - a redirect from https to http is refused;
 * - the real DNS path (dns.Resolver) against a tiny local DNS server:
 *   answers are vetted, and a lookup that never answers is cancelled at
 *   the deadline.
 */
import { execFileSync } from "node:child_process";
import dgram from "node:dgram";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SafeFetchError, createSystemNetwork, safeFetch, type FetchFailure, type NetworkDeps, type ResolvedAddress, type SafeFetchOptions } from "./safe-fetch";
import { PUBLIC_V4, PUBLIC_V4_B, PUBLIC_V6, html, redirect, startTestServer, testNetwork, type TestServer } from "./test-support";

const OPTIONS: SafeFetchOptions = {
  maxBytes: 64 * 1024,
  accept: "text/html",
  acceptType: (type) => type === null || type.startsWith("text/html"),
  idleTimeoutMs: 2_000,
  totalTimeoutMs: 4_000,
};

async function failureOf(promise: Promise<unknown>): Promise<FetchFailure> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SafeFetchError) return error.failure;
    throw error;
  }
  throw new Error("expected the fetch to fail");
}

let server: TestServer;

beforeEach(async () => {
  server = await startTestServer();
});

afterEach(async () => {
  await server.close();
});

// ---------------------------------------------------------------------------
// Happy eyeballs
// ---------------------------------------------------------------------------

describe("every vetted address is pinned", () => {
  /** IPv6 addresses go to [::1] on a port nothing listens on there (our server is IPv4 only). */
  function dualStack(order: "v6-first" | "v4-first"): NetworkDeps & { dialed: ResolvedAddress[] } {
    const base = testNetwork(server.port, {
      "shop.example": order === "v6-first" ? [PUBLIC_V6, PUBLIC_V4] : [PUBLIC_V4, PUBLIC_V6],
    });
    return Object.assign(base, {
      dial(address: ResolvedAddress) {
        base.dialed.push(address);
        return address.family === 6
          ? { address: "::1", family: 6 as const, port: server.port }
          : { address: "127.0.0.1", family: 4 as const, port: server.port };
      },
    });
  }

  it("falls back from an unreachable IPv6 address to IPv4", async () => {
    server.routes.set("shop.example/p", html("over v4"));
    const network = dualStack("v6-first");
    const result = await safeFetch("http://shop.example/p", OPTIONS, network);
    expect(new TextDecoder().decode(result.body)).toBe("over v4");
    // Both vetted addresses were handed to the connection, in DNS order.
    expect(network.dialed).toEqual([
      { address: PUBLIC_V6, family: 6 },
      { address: PUBLIC_V4, family: 4 },
    ]);
  });

  it("with only an unreachable address, the fetch fails rather than going anywhere else", async () => {
    const network = testNetwork(server.port, { "shop.example": [PUBLIC_V6] });
    network.dial = () => ({ address: "::1", family: 6, port: server.port });
    expect(await failureOf(safeFetch("http://shop.example/p", OPTIONS, network))).toBe("network");
  });

  it("one private address among several still refuses the lot", async () => {
    const network = testNetwork(server.port, { "shop.example": [PUBLIC_V6, PUBLIC_V4, "10.0.0.7"] });
    expect(await failureOf(safeFetch("http://shop.example/p", OPTIONS, network))).toBe("private_address");
    expect(network.dialed).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// HTTPS
// ---------------------------------------------------------------------------

function hasOpenssl(): boolean {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe.runIf(hasOpenssl())("https", () => {
  let dir: string;
  let cert: Buffer;
  let tlsServer: https.Server;
  let tlsPort: number;
  let tlsRoutes: Map<string, (res: import("node:http").ServerResponse) => void>;
  let sniNames: string[];

  beforeEach(async () => {
    // A self-signed certificate for www.shop.example only, generated now.
    dir = mkdtempSync(join(tmpdir(), "gladrags-link-tls-"));
    execFileSync(
      "openssl",
      [
        "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
        "-subj", "/CN=www.shop.example",
        "-addext", "subjectAltName=DNS:www.shop.example",
        "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"),
      ],
      { stdio: "ignore" },
    );
    cert = readFileSync(join(dir, "cert.pem"));
    tlsRoutes = new Map();
    sniNames = [];
    tlsServer = https.createServer(
      {
        key: readFileSync(join(dir, "key.pem")),
        cert,
        SNICallback: (name, cb) => {
          sniNames.push(name);
          cb(null);
        },
      },
      (req, res) => {
        const handler = tlsRoutes.get(req.url ?? "/");
        if (handler) return handler(res);
        res.writeHead(404).end();
      },
    );
    await new Promise<void>((resolve) => tlsServer.listen(0, "127.0.0.1", resolve));
    tlsPort = (tlsServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    tlsServer.closeAllConnections();
    await new Promise<void>((resolve) => tlsServer.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  /** 443 goes to the TLS server, 80 to the plain one; the test CA is trusted unless `trust` is false. */
  function tlsNetwork({ trust = true } = {}): NetworkDeps & { ports: number[] } {
    const base = testNetwork(server.port, { "www.shop.example": [PUBLIC_V4], "other.shop.example": [PUBLIC_V4_B], "shop.example": [PUBLIC_V4] });
    const ports: number[] = [];
    return Object.assign(base, {
      ports,
      ...(trust ? { tls: { ca: cert } } : {}),
      dial(address: ResolvedAddress, port: number) {
        base.dialed.push(address);
        ports.push(port);
        return { address: "127.0.0.1", family: 4 as const, port: port === 443 ? tlsPort : server.port };
      },
    });
  }

  it("fetches over https when the certificate matches the host name, sending SNI", async () => {
    tlsRoutes.set("/p", (res) => res.writeHead(200, { "content-type": "text/html" }).end("secure"));
    const network = tlsNetwork();
    const result = await safeFetch("https://www.shop.example/p", OPTIONS, network);
    expect(new TextDecoder().decode(result.body)).toBe("secure");
    expect(sniNames).toEqual(["www.shop.example"]);
    expect(network.ports).toEqual([443]);
  });

  it("refuses a certificate for a different host name, even from a trusted CA", async () => {
    tlsRoutes.set("/p", (res) => res.writeHead(200, { "content-type": "text/html" }).end("should not be read"));
    expect(await failureOf(safeFetch("https://other.shop.example/p", OPTIONS, tlsNetwork()))).toBe("network");
    expect(sniNames).toEqual(["other.shop.example"]);
  });

  it("refuses an untrusted certificate", async () => {
    tlsRoutes.set("/p", (res) => res.writeHead(200, { "content-type": "text/html" }).end("should not be read"));
    expect(await failureOf(safeFetch("https://www.shop.example/p", OPTIONS, tlsNetwork({ trust: false })))).toBe("network");
  });

  it("follows http -> https", async () => {
    server.routes.set("www.shop.example/p", redirect("https://www.shop.example/secure"));
    tlsRoutes.set("/secure", (res) => res.writeHead(200, { "content-type": "text/html" }).end("upgraded"));
    const network = tlsNetwork();
    const result = await safeFetch("http://www.shop.example/p", OPTIONS, network);
    expect(result.finalUrl.href).toBe("https://www.shop.example/secure");
    expect(network.ports).toEqual([80, 443]);
  });

  it("refuses https -> http (a downgrade), without making the insecure request", async () => {
    tlsRoutes.set("/p", (res) => res.writeHead(302, { location: "http://shop.example/insecure" }).end());
    server.routes.set("shop.example/insecure", html("should not be reached"));
    const network = tlsNetwork();
    expect(await failureOf(safeFetch("https://www.shop.example/p", OPTIONS, network))).toBe("insecure_redirect");
    expect(network.ports).toEqual([443]);
    expect(server.requests).toEqual([]);
  });

  it("refuses a downgrade further down the chain too", async () => {
    server.routes.set("www.shop.example/start", redirect("https://www.shop.example/a"));
    tlsRoutes.set("/a", (res) => res.writeHead(301, { location: "http://shop.example/b" }).end());
    expect(await failureOf(safeFetch("http://www.shop.example/start", OPTIONS, tlsNetwork()))).toBe("insecure_redirect");
    expect(server.requests.map((r) => r.path)).toEqual(["/start"]);
  });
});

// ---------------------------------------------------------------------------
// The real DNS path (dns.Resolver) against a local DNS server
// ---------------------------------------------------------------------------

/** A minimal DNS server: answers A queries from `records`, AAAA with no data, and ignores names in `silent`. */
async function startDnsServer(records: Record<string, string[]>, silent: string[] = []) {
  const socket = dgram.createSocket("udp4");
  const queries: { name: string; type: number }[] = [];
  socket.on("message", (msg, rinfo) => {
    // Header (12 bytes), then the question: labels, type, class.
    let offset = 12;
    const labels: string[] = [];
    while (msg[offset]! > 0) {
      const length = msg[offset]!;
      labels.push(msg.subarray(offset + 1, offset + 1 + length).toString("latin1"));
      offset += length + 1;
    }
    const questionEnd = offset + 5;
    const type = msg.readUInt16BE(offset + 1);
    const name = labels.join(".").toLowerCase();
    queries.push({ name, type });
    if (silent.includes(name)) return;

    const addresses = type === 1 ? (records[name] ?? []) : [];
    const known = name in records;
    const header = Buffer.alloc(12);
    msg.copy(header, 0, 0, 2); // same ID
    header.writeUInt16BE(known ? 0x8180 : 0x8183, 2); // response, recursion; NXDOMAIN if unknown
    header.writeUInt16BE(1, 4);
    header.writeUInt16BE(addresses.length, 6);
    const answers = addresses.map((address) => {
      const answer = Buffer.alloc(16);
      answer.writeUInt16BE(0xc00c, 0); // pointer to the question's name
      answer.writeUInt16BE(1, 2); // A
      answer.writeUInt16BE(1, 4); // IN
      answer.writeUInt32BE(60, 6); // TTL
      answer.writeUInt16BE(4, 10);
      address.split(".").forEach((part, i) => answer.writeUInt8(Number(part), 12 + i));
      return answer;
    });
    socket.send(Buffer.concat([header, msg.subarray(12, questionEnd), ...answers]), rinfo.port, rinfo.address);
  });
  await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", resolve));
  const { port } = socket.address();
  return { server: `127.0.0.1:${port}`, queries, close: () => new Promise<void>((resolve) => socket.close(() => resolve())) };
}

describe("system DNS (dns.Resolver)", () => {
  let dns: Awaited<ReturnType<typeof startDnsServer>>;

  beforeEach(async () => {
    dns = await startDnsServer(
      { "shop.example": [PUBLIC_V4], "rebind.attacker.example": ["127.0.0.1"], "meta.attacker.example": [PUBLIC_V4, "169.254.169.254"] },
      ["slow.example"],
    );
  });

  afterEach(async () => {
    await dns.close();
  });

  /** The real resolver, pointed at the local DNS server, with connections sent to the local web server. */
  function systemWith(): NetworkDeps & { dialed: ResolvedAddress[] } {
    const dialed: ResolvedAddress[] = [];
    return {
      ...createSystemNetwork({ servers: [dns.server] }),
      dialed,
      dial(address) {
        dialed.push(address);
        return { address: "127.0.0.1", family: 4, port: server.port };
      },
    };
  }

  it("resolves A and AAAA from the DNS server and connects to the vetted address", async () => {
    server.routes.set("shop.example/p", html("via resolver"));
    const network = systemWith();
    const result = await safeFetch("http://shop.example/p", OPTIONS, network);
    expect(new TextDecoder().decode(result.body)).toBe("via resolver");
    expect(network.dialed).toEqual([{ address: PUBLIC_V4, family: 4 }]);
    expect(dns.queries.map((q) => q.type).sort()).toEqual([1, 28]); // A and AAAA
  });

  it("refuses private answers from real DNS", async () => {
    expect(await failureOf(safeFetch("http://rebind.attacker.example/", OPTIONS, systemWith()))).toBe("private_address");
    expect(await failureOf(safeFetch("http://meta.attacker.example/", OPTIONS, systemWith()))).toBe("private_address");
  });

  it("an unknown name is dns_failed", async () => {
    expect(await failureOf(safeFetch("http://nowhere.example/", OPTIONS, systemWith()))).toBe("dns_failed");
  });

  it("a DNS server that never answers is cancelled at the deadline", async () => {
    const started = Date.now();
    expect(await failureOf(safeFetch("http://slow.example/", { ...OPTIONS, totalTimeoutMs: 300 }, systemWith()))).toBe("timeout");
    // Well under the resolver's own 2 s x 2 tries: the deadline cancelled it.
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(dns.queries.some((q) => q.name === "slow.example")).toBe(true);
  });

  it("asks the DNS server for every name (no getaddrinfo, so /etc/hosts and search domains don't apply)", async () => {
    await failureOf(safeFetch("http://nowhere.example/", OPTIONS, systemWith()));
    expect(dns.queries.map((q) => q.name)).toEqual(["nowhere.example", "nowhere.example"]);
  });
});
