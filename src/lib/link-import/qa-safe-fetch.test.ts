/**
 * QA: adversarial tests for the SSRF-safe fetcher. Local servers only (no
 * real network): redirect tricks, mixed and rebinding DNS answers, scheme
 * changes, non-default ports, slow and lying servers, and compression
 * bombs in every encoding the fetcher accepts.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import https from "node:https";
import net, { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, constants as zlibConstants, deflateSync, gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SafeFetchError, safeFetch, type FetchFailure, type NetworkDeps, type ResolvedAddress, type SafeFetchOptions } from "./safe-fetch";
import { PUBLIC_V4, PUBLIC_V4_B, PUBLIC_V6, html, redirect, startTestServer, testNetwork, type TestNetwork, type TestServer } from "./test-support";

const OPTIONS: SafeFetchOptions = {
  maxBytes: 64 * 1024,
  accept: "text/html",
  acceptType: (type) => type === null || type.startsWith("text/html"),
  idleTimeoutMs: 1_000,
  totalTimeoutMs: 3_000,
};

let server: TestServer;
let network: TestNetwork;

beforeEach(async () => {
  server = await startTestServer();
  network = testNetwork(server.port, {
    "shop.example": [PUBLIC_V4],
    "www.shop.example": [PUBLIC_V4_B],
    "v6.shop.example": [PUBLIC_V6],
    "private-first.attacker.example": ["10.1.2.3", PUBLIC_V4],
    "private-last.attacker.example": [PUBLIC_V4, PUBLIC_V4_B, "127.0.0.1"],
    "v6-private.attacker.example": [PUBLIC_V4, "fe80::1"],
    "v6-mapped.attacker.example": [PUBLIC_V4, "::ffff:169.254.169.254"],
    "nat64.attacker.example": ["64:ff9b::a9fe:a9fe"],
    "zero.attacker.example": ["0.0.0.0"],
    "unspecified.attacker.example": ["::"],
    "garbage.attacker.example": ["not-an-ip"],
    "empty.attacker.example": [],
  });
});

afterEach(async () => {
  await server.close();
});

async function failureOf(promise: Promise<unknown>): Promise<FetchFailure> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SafeFetchError) return error.failure;
    throw error;
  }
  throw new Error("expected the fetch to fail");
}

describe("mixed and odd DNS answers", () => {
  it.each([
    "private-first.attacker.example",
    "private-last.attacker.example",
    "v6-private.attacker.example",
    "v6-mapped.attacker.example",
    "nat64.attacker.example",
    "zero.attacker.example",
    "unspecified.attacker.example",
    "garbage.attacker.example",
  ])("%s: one bad address refuses the lot, before any connection", async (host) => {
    expect(await failureOf(safeFetch(`http://${host}/`, OPTIONS, network))).toBe("private_address");
    expect(network.dialed).toEqual([]);
    expect(server.requests).toEqual([]);
  });

  it("an empty DNS answer is a DNS failure, not a connection", async () => {
    expect(await failureOf(safeFetch("http://empty.attacker.example/", OPTIONS, network))).toBe("dns_failed");
    expect(network.dialed).toEqual([]);
  });
});

describe("DNS rebinding between the check and the connect", () => {
  it("the HTTP layer never does its own lookup: a name only our fake DNS knows still connects to the vetted address", async () => {
    // If Node fell back to the system resolver, this made-up name would fail.
    network.dns.set("only-in-fake-dns.example", [PUBLIC_V4]);
    server.routes.set("only-in-fake-dns.example/", html("pinned"));
    const result = await safeFetch("http://only-in-fake-dns.example/", OPTIONS, network);
    expect(new TextDecoder().decode(result.body)).toBe("pinned");
    expect(network.lookups).toEqual(["only-in-fake-dns.example"]);
  });

  it("an answer that changes after vetting (public, then private) can't redirect the connection", async () => {
    server.routes.set("shop.example/p", html("ok"));
    const answers = [[PUBLIC_V4], ["127.0.0.1"], ["169.254.169.254"]];
    network.resolve = async (host) => {
      network.lookups.push(host);
      return (answers.shift() ?? ["10.0.0.1"]).map((address) => ({ address, family: 4 as const }));
    };
    await safeFetch("http://shop.example/p", OPTIONS, network);
    expect(network.lookups).toHaveLength(1);
    expect(network.dialed).toEqual([{ address: PUBLIC_V4, family: 4 }]);
  });
});

describe("redirect Location tricks", () => {
  it.each([
    ["a protocol-relative loopback", "//127.0.0.1/admin", "private_address"],
    ["a triple-slash loopback", "///127.0.0.1/", "private_address"],
    ["backslashes", "\\\\127.0.0.1\\admin", "private_address"],
    ["a decimal loopback", "http://2130706433/", "private_address"],
    ["a short-form loopback", "http://127.1/", "private_address"],
    ["an octal loopback", "http://0177.0.0.1/", "private_address"],
    ["a hex short form", "http://0x7f.1/", "private_address"],
    ["IPv6 unspecified", "http://[::]/", "private_address"],
    ["IPv4-mapped loopback", "http://[::ffff:127.0.0.1]/", "private_address"],
    ["userinfo pointing at loopback", "http://shop.example@127.0.0.1/", "url_refused"],
    ["localhost with a trailing dot", "http://localhost./", "url_refused"],
    ["file:", "file:///etc/passwd", "url_refused"],
    ["data:", "data:text/html,<h1>hi</h1>", "url_refused"],
    ["javascript:", "javascript:alert(1)", "url_refused"],
    ["ftp:", "ftp://shop.example/x", "url_refused"],
    ["gopher:", "gopher://127.0.0.1:6379/_FLUSHALL", "url_refused"],
    ["a non-default port on the same public host", "http://shop.example:8080/", "url_refused"],
    ["a protocol-relative non-default port", "//www.shop.example:2375/", "url_refused"],
    ["port 443 over plain http", "http://shop.example:443/", "url_refused"],
  ])("refuses %s, with no second request", async (_label, location, expected) => {
    server.routes.set("shop.example/go", redirect(location));
    expect(await failureOf(safeFetch("http://shop.example/go", OPTIONS, network))).toBe(expected);
    expect(server.requests.map((r) => `${r.host}${r.path}`)).toEqual(["shop.example/go"]);
    expect(network.dialed.map((d) => d.address)).toEqual([PUBLIC_V4]);
  });

  it("a relative path redirect stays on the host and is re-resolved", async () => {
    server.routes.set("shop.example/a/b", redirect("../c?x=1"));
    server.routes.set("shop.example/c?x=1", html("relative"));
    const result = await safeFetch("http://shop.example/a/b", OPTIONS, network);
    expect(result.finalUrl.href).toBe("http://shop.example/c?x=1");
    expect(network.lookups).toEqual(["shop.example", "shop.example"]);
  });

  it("a redirect's fragment isn't sent", async () => {
    server.routes.set("shop.example/a", redirect("/b#@127.0.0.1"));
    server.routes.set("shop.example/b", html("ok"));
    const result = await safeFetch("http://shop.example/a", OPTIONS, network);
    expect(result.finalUrl.href).toBe("http://shop.example/b");
  });
});

describe("redirect status codes", () => {
  it.each([301, 302, 303, 307, 308])("%i is followed with a GET and no body", async (status) => {
    const seen: { method: string; length: string | undefined }[] = [];
    server.routes.set("shop.example/from", (req, res) => {
      seen.push({ method: req.method!, length: req.headers["content-length"] });
      res.writeHead(status, { location: "/to" }).end();
    });
    server.routes.set("shop.example/to", (req, res) => {
      seen.push({ method: req.method!, length: req.headers["content-length"] });
      res.writeHead(200, { "content-type": "text/html" }).end("ok");
    });
    await safeFetch("http://shop.example/from", OPTIONS, network);
    expect(seen).toEqual([
      { method: "GET", length: undefined },
      { method: "GET", length: undefined },
    ]);
  });

  it.each([300, 304, 305, 306])("%i with a Location is not followed", async (status) => {
    server.routes.set("shop.example/odd", (_req, res) => res.writeHead(status, { location: "http://127.0.0.1/" }).end());
    expect(await failureOf(safeFetch("http://shop.example/odd", OPTIONS, network))).toBe("http_status");
    expect(server.requests).toHaveLength(1);
  });

  it("a redirect with a large body doesn't count against the cap or get read", async () => {
    server.routes.set("shop.example/r", (_req, res) => {
      res.writeHead(302, { location: "/final" });
      res.write("z".repeat(OPTIONS.maxBytes * 2));
      // Left open: the fetcher must move on without waiting for the end.
    });
    server.routes.set("shop.example/final", html("done"));
    const result = await safeFetch("http://shop.example/r", OPTIONS, network);
    expect(new TextDecoder().decode(result.body)).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// http <-> https. The fetcher can't be told to trust a test CA (by design),
// so the https side is a server with a throwaway self-signed certificate:
// the fetcher must try TLS on 443, send the original host name as SNI, and
// refuse the untrusted certificate.
// ---------------------------------------------------------------------------

function hasOpenssl(): boolean {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe.runIf(hasOpenssl())("scheme changes on redirect", () => {
  let tlsServer: https.Server;
  let tlsPort: number;
  let sniNames: string[];
  let tlsRequests: string[];
  let dir: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "gladrags-qa-tls-"));
    execFileSync(
      "openssl",
      ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=www.shop.example", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem")],
      { stdio: "ignore" },
    );
    sniNames = [];
    tlsRequests = [];
    tlsServer = https.createServer(
      {
        key: readFileSync(join(dir, "k.pem")),
        cert: readFileSync(join(dir, "c.pem")),
        SNICallback: (name, cb) => {
          sniNames.push(name);
          cb(null);
        },
      },
      (req, res) => {
        tlsRequests.push(req.url ?? "");
        res.writeHead(200, { "content-type": "text/html" }).end("over tls");
      },
    );
    await new Promise<void>((resolve) => tlsServer.listen(0, "127.0.0.1", resolve));
    tlsPort = (tlsServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => tlsServer.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  /** Port-aware dialing: 80 goes to the plain server, 443 to the TLS one. */
  function dualNetwork(): TestNetwork & { ports: number[] } {
    const base = testNetwork(server.port, { "shop.example": [PUBLIC_V4], "www.shop.example": [PUBLIC_V4_B] });
    const ports: number[] = [];
    return Object.assign(base, {
      ports,
      dial(address: ResolvedAddress, port: number) {
        base.dialed.push(address);
        ports.push(port);
        return { address: "127.0.0.1", family: 4 as const, port: port === 443 ? tlsPort : server.port };
      },
    });
  }

  it("http -> https: re-vets the new host, connects on 443 with SNI, and refuses an untrusted certificate", async () => {
    const dual = dualNetwork();
    server.routes.set("shop.example/p", redirect("https://www.shop.example/p"));
    expect(await failureOf(safeFetch("http://shop.example/p", OPTIONS, dual))).toBe("network");
    expect(dual.lookups).toEqual(["shop.example", "www.shop.example"]);
    expect(dual.ports).toEqual([80, 443]);
    expect(sniNames).toEqual(["www.shop.example"]);
    // The handshake failed, so no request was ever sent over it.
    expect(tlsRequests).toEqual([]);
  });

  it("https -> http (a downgrade) is still checked like any other hop", async () => {
    // Can't complete the first TLS hop with an untrusted cert; this just pins
    // that a https URL is dialled on 443 and fails closed.
    const dual = dualNetwork();
    expect(await failureOf(safeFetch("https://shop.example/p", OPTIONS, dual))).toBe("network");
    expect(dual.ports).toEqual([443]);
    expect(sniNames).toEqual(["shop.example"]);
  });

  it("an https IPv6 host is dialled on 443 with the bare address", async () => {
    const dual = dualNetwork();
    dual.dns.set("v6.shop.example", [PUBLIC_V6]);
    expect(await failureOf(safeFetch("https://v6.shop.example/", OPTIONS, dual))).toBe("network");
    expect(dual.dialed).toEqual([{ address: PUBLIC_V6, family: 6 }]);
    expect(dual.ports).toEqual([443]);
  });
});

// ---------------------------------------------------------------------------
// Slow and lying servers
// ---------------------------------------------------------------------------

/** A raw TCP server, for responses http.createServer won't produce. */
async function rawServer(onConnection: (socket: net.Socket) => void): Promise<{ network: NetworkDeps; close(): Promise<void> }> {
  const sockets = new Set<net.Socket>();
  const tcp = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    onConnection(socket);
  });
  await new Promise<void>((resolve) => tcp.listen(0, "127.0.0.1", resolve));
  const port = (tcp.address() as AddressInfo).port;
  return {
    network: {
      async resolve() {
        return [{ address: PUBLIC_V4, family: 4 }];
      },
      dial() {
        return { address: "127.0.0.1", family: 4, port };
      },
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        tcp.close(() => resolve());
      }),
  };
}

describe("slowloris", () => {
  it("headers dripped a byte at a time under the idle timeout still hit the total deadline", async () => {
    const head = "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nX-Pad: " + "a".repeat(10_000) + "\r\n\r\nok";
    const raw = await rawServer((socket) => {
      let i = 0;
      const timer = setInterval(() => {
        if (socket.destroyed || i >= head.length) return clearInterval(timer);
        socket.write(head[i++]!);
      }, 20);
      socket.on("close", () => clearInterval(timer));
    });
    try {
      const started = Date.now();
      const failure = await failureOf(safeFetch("http://shop.example/", { ...OPTIONS, idleTimeoutMs: 300, totalTimeoutMs: 600 }, raw.network));
      expect(failure).toBe("timeout");
      expect(Date.now() - started).toBeLessThan(1_500);
    } finally {
      await raw.close();
    }
  });

  it("the deadline covers the whole redirect chain, not each hop", async () => {
    for (let i = 0; i < 3; i++) {
      server.routes.set(`shop.example/slow${i}`, (_req, res) => {
        setTimeout(() => res.writeHead(302, { location: `/slow${i + 1}` }).end(), 250);
      });
    }
    server.routes.set("shop.example/slow3", html("too late"));
    const started = Date.now();
    const failure = await failureOf(safeFetch("http://shop.example/slow0", { ...OPTIONS, idleTimeoutMs: 400, totalTimeoutMs: 600 }, network));
    expect(failure).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it("a body dripped under the idle timeout is cut off by the deadline, and the socket is closed", async () => {
    let closed = false;
    server.routes.set("shop.example/drip", (_req, res) => {
      res.writeHead(200, { "content-type": "text/html", "content-length": "60000" });
      const timer = setInterval(() => res.write("."), 30);
      res.on("close", () => {
        clearInterval(timer);
        closed = true;
      });
    });
    expect(await failureOf(safeFetch("http://shop.example/drip", { ...OPTIONS, idleTimeoutMs: 300, totalTimeoutMs: 500 }, network))).toBe("timeout");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(closed).toBe(true);
  });

  it("a server that accepts the connection and says nothing hits the idle timeout", async () => {
    const raw = await rawServer(() => {});
    try {
      const started = Date.now();
      expect(await failureOf(safeFetch("http://shop.example/", { ...OPTIONS, idleTimeoutMs: 200, totalTimeoutMs: 5_000 }, raw.network))).toBe("timeout");
      expect(Date.now() - started).toBeLessThan(1_500);
    } finally {
      await raw.close();
    }
  });
});

describe("Content-Length lies", () => {
  it("declared shorter than sent: never more than the declared bytes (Node may also refuse the trailing junk)", async () => {
    const raw = await rawServer((socket) => {
      socket.write(`HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello${"x".repeat(200_000)}`);
      socket.end();
    });
    try {
      const outcome = await safeFetch("http://shop.example/", OPTIONS, raw.network).then(
        (result) => new TextDecoder().decode(result.body),
        (error: unknown) => (error instanceof SafeFetchError ? `failed:${error.failure}` : Promise.reject(error)),
      );
      expect(["hello", "failed:network"]).toContain(outcome);
    } finally {
      await raw.close();
    }
  });

  it("declared longer than sent, then the connection closes: a network failure, not a short body", async () => {
    const raw = await rawServer((socket) => {
      socket.write("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 1000\r\n\r\nshort");
      setTimeout(() => socket.end(), 20);
    });
    try {
      expect(await failureOf(safeFetch("http://shop.example/", OPTIONS, raw.network))).toBe("network");
    } finally {
      await raw.close();
    }
  });

  it("two different Content-Length headers are refused", async () => {
    const raw = await rawServer((socket) => {
      socket.end("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 5\r\nContent-Length: 500000\r\n\r\nhello");
    });
    try {
      expect(await failureOf(safeFetch("http://shop.example/", OPTIONS, raw.network))).toBe("network");
    } finally {
      await raw.close();
    }
  });

  it("Content-Length and chunked together are refused (request-smuggling shape)", async () => {
    const raw = await rawServer((socket) => {
      socket.end("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 3\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n");
    });
    try {
      expect(await failureOf(safeFetch("http://shop.example/", OPTIONS, raw.network))).toBe("network");
    } finally {
      await raw.close();
    }
  });

  it("a small declared length with a gzip body that inflates past the cap is still refused", async () => {
    const bomb = gzipSync(Buffer.alloc(OPTIONS.maxBytes * 50, 0x20));
    server.routes.set("shop.example/z", (_req, res) => {
      res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip", "content-length": String(bomb.length) }).end(bomb);
    });
    expect(await failureOf(safeFetch("http://shop.example/z", OPTIONS, network))).toBe("too_large");
  });
});

describe("the byte cap boundary", () => {
  it("exactly maxBytes is fine; one more is too large", async () => {
    server.routes.set("shop.example/exact", html("a".repeat(OPTIONS.maxBytes)));
    server.routes.set("shop.example/over", (_req, res) => {
      // Chunked, so the streaming check (not the header check) decides.
      res.writeHead(200, { "content-type": "text/html" });
      res.write("a".repeat(OPTIONS.maxBytes));
      res.end("a");
    });
    expect((await safeFetch("http://shop.example/exact", OPTIONS, network)).body.byteLength).toBe(OPTIONS.maxBytes);
    expect(await failureOf(safeFetch("http://shop.example/over", OPTIONS, network))).toBe("too_large");
  });

  it("an endless chunked stream is cut off, not buffered", async () => {
    let written = 0;
    server.routes.set("shop.example/forever", (_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      const pump = () => {
        while (!res.destroyed && res.write("q".repeat(8192))) written += 8192;
        if (!res.destroyed) res.once("drain", pump);
      };
      pump();
    });
    expect(await failureOf(safeFetch("http://shop.example/forever", OPTIONS, network))).toBe("too_large");
    expect(written).toBeLessThan(OPTIONS.maxBytes * 64);
  });
});

describe("compression bombs", () => {
  const plain = Buffer.alloc(32 * 1024 * 1024, 0x61); // 32 MB of "a"

  it.each([
    ["gzip", () => gzipSync(plain)],
    ["x-gzip", () => gzipSync(plain)],
    ["deflate", () => deflateSync(plain)],
    ["br", () => brotliCompressSync(plain, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 } })],
    ["GZIP", () => gzipSync(plain)], // case-insensitive
  ])("%s: stops at the decompressed cap", async (encoding, make) => {
    const bomb = make();
    expect(bomb.length).toBeLessThan(OPTIONS.maxBytes * 16);
    server.routes.set("shop.example/bomb", (_req, res) => {
      res.writeHead(200, { "content-type": "text/html", "content-encoding": encoding }).end(bomb);
    });
    const started = Date.now();
    expect(await failureOf(safeFetch("http://shop.example/bomb", OPTIONS, network))).toBe("too_large");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("a gzip bomb nested inside gzip (Content-Encoding: gzip, gzip) is refused", async () => {
    const doubled = gzipSync(gzipSync(plain));
    server.routes.set("shop.example/double", (_req, res) => {
      res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip, gzip" }).end(doubled);
    });
    expect(await failureOf(safeFetch("http://shop.example/double", OPTIONS, network))).toBe("network");
  });

  it("a body that claims gzip but isn't is a network failure, not a crash", async () => {
    server.routes.set("shop.example/fake-gzip", (_req, res) => {
      res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" }).end("<html>not zipped</html>");
    });
    expect(await failureOf(safeFetch("http://shop.example/fake-gzip", OPTIONS, network))).toBe("network");
  });

  it("brotli and deflate still decode normal pages", async () => {
    server.routes.set("shop.example/br", (_req, res) => {
      res.writeHead(200, { "content-type": "text/html", "content-encoding": "br" }).end(brotliCompressSync(Buffer.from("<p>br</p>")));
    });
    server.routes.set("shop.example/deflate", (_req, res) => {
      res.writeHead(200, { "content-type": "text/html", "content-encoding": "deflate" }).end(deflateSync(Buffer.from("<p>deflate</p>")));
    });
    expect(new TextDecoder().decode((await safeFetch("http://shop.example/br", OPTIONS, network)).body)).toBe("<p>br</p>");
    expect(new TextDecoder().decode((await safeFetch("http://shop.example/deflate", OPTIONS, network)).body)).toBe("<p>deflate</p>");
  });
});

describe("requests stay plain", () => {
  it("sends no Referer, cookies or auth, and the Host is the URL's host name without a port", async () => {
    server.routes.set("shop.example/a", redirect("http://www.shop.example/b", 302, { "set-cookie": "sid=1; Domain=shop.example" }));
    server.routes.set("www.shop.example/b", html("ok"));
    await safeFetch("http://shop.example/a", OPTIONS, network);
    for (const request of server.requests) {
      expect(request.headers.referer).toBeUndefined();
      expect(request.headers.cookie).toBeUndefined();
      expect(request.headers.authorization).toBeUndefined();
    }
    // The raw Host header (the test server strips the port before routing).
    expect(server.requests.map((r) => r.host)).toEqual(["shop.example", "www.shop.example"]);
  });

  it("never uses a keep-alive socket from a previous fetch (agent: false)", async () => {
    const remotePorts = new Set<number>();
    server.routes.set("shop.example/k", (req, res) => {
      remotePorts.add(req.socket.remotePort!);
      res.writeHead(200, { "content-type": "text/html", connection: "keep-alive" }).end("k");
    });
    await safeFetch("http://shop.example/k", OPTIONS, network);
    await safeFetch("http://shop.example/k", OPTIONS, network);
    expect(remotePorts.size).toBe(2);
  });
});
