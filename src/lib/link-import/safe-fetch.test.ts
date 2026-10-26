/**
 * The SSRF-safe fetcher against a local HTTP server (no real network):
 * redirects re-checked hop by hop, DNS answers vetted and pinned, size and
 * time caps, content types, and no cookies.
 */
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_REDIRECTS, SafeFetchError, USER_AGENT, safeFetch, type FetchFailure, type SafeFetchOptions } from "./safe-fetch";
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
    "cdn.shop.example": [PUBLIC_V4],
    "internal.attacker.example": ["10.0.0.5"],
    "metadata.attacker.example": ["169.254.169.254"],
    "loopback.attacker.example": ["127.0.0.1"],
    "mapped.attacker.example": ["::ffff:127.0.0.1"],
    "ula.attacker.example": ["fd00::1"],
    "mixed.attacker.example": [PUBLIC_V4, "192.168.1.10"],
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

describe("an ordinary fetch", () => {
  it("returns the body, type and final URL, connecting to the vetted address", async () => {
    server.routes.set("shop.example/p/1", html("<p>hello</p>"));
    const result = await safeFetch("http://shop.example/p/1", OPTIONS, network);
    expect(new TextDecoder().decode(result.body)).toBe("<p>hello</p>");
    expect(result.contentType).toBe("text/html; charset=utf-8");
    expect(result.finalUrl.href).toBe("http://shop.example/p/1");
    expect(network.lookups).toEqual(["shop.example"]);
    expect(network.dialed).toEqual([{ address: PUBLIC_V4, family: 4 }]);
  });

  it("sends a plain User-Agent and no cookies or credentials", async () => {
    server.routes.set("shop.example/a", redirect("/b", 302, { "set-cookie": "session=abc; Path=/" }));
    server.routes.set("shop.example/b", html("ok"));
    await safeFetch("http://shop.example/a", OPTIONS, network);
    expect(server.requests).toHaveLength(2);
    for (const { headers } of server.requests) {
      expect(headers["user-agent"]).toBe(USER_AGENT);
      expect(headers.cookie).toBeUndefined();
      expect(headers.authorization).toBeUndefined();
    }
  });

  it("works over IPv6 public addresses", async () => {
    server.routes.set("v6.shop.example/", html("v6"));
    await safeFetch("http://v6.shop.example/", OPTIONS, network);
    expect(network.dialed).toEqual([{ address: PUBLIC_V6, family: 6 }]);
  });

  it("decompresses gzip", async () => {
    server.routes.set("shop.example/gz", (_req, res) => {
      res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" }).end(gzipSync("<p>zipped</p>"));
    });
    const result = await safeFetch("http://shop.example/gz", OPTIONS, network);
    expect(new TextDecoder().decode(result.body)).toBe("<p>zipped</p>");
  });
});

describe("refused before connecting", () => {
  it.each([
    ["a private address literal", "http://127.0.0.1/", "private_address"],
    ["the cloud metadata address", "http://169.254.169.254/latest/meta-data/", "private_address"],
    ["a decimal loopback", "http://2130706433/", "private_address"],
    ["an IPv6 loopback", "http://[::1]/", "private_address"],
    ["a name resolving to 10/8", "http://internal.attacker.example/", "private_address"],
    ["a name resolving to the metadata address", "http://metadata.attacker.example/", "private_address"],
    ["a name resolving to loopback", "http://loopback.attacker.example/", "private_address"],
    ["a name resolving to IPv4-mapped loopback", "http://mapped.attacker.example/", "private_address"],
    ["a name resolving to unique local IPv6", "http://ula.attacker.example/", "private_address"],
    ["a name with one private address among public ones", "http://mixed.attacker.example/", "private_address"],
    ["a non-default port", "http://shop.example:8080/", "url_refused"],
    ["ftp", "ftp://shop.example/", "url_refused"],
    ["credentials", "http://admin:admin@shop.example/", "url_refused"],
    ["localhost", "http://localhost/", "url_refused"],
    ["a name that doesn't resolve", "http://nowhere.example/", "dns_failed"],
  ])("%s", async (_label, url, expected) => {
    expect(await failureOf(safeFetch(url, OPTIONS, network))).toBe(expected);
    expect(network.dialed).toEqual([]);
    expect(server.requests).toEqual([]);
  });
});

describe("redirects are re-checked on every hop", () => {
  it("follows relative and absolute redirects to public hosts", async () => {
    server.routes.set("shop.example/a", redirect("/b", 301));
    server.routes.set("shop.example/b", redirect("http://www.shop.example/c", 307));
    server.routes.set("www.shop.example/c", html("final"));
    const result = await safeFetch("http://shop.example/a", OPTIONS, network);
    expect(result.finalUrl.href).toBe("http://www.shop.example/c");
    expect(network.lookups).toEqual(["shop.example", "shop.example", "www.shop.example"]);
    expect(network.dialed.map((d) => d.address)).toEqual([PUBLIC_V4, PUBLIC_V4, PUBLIC_V4_B]);
  });

  it.each([
    ["a loopback literal", "http://127.0.0.1/admin", "private_address"],
    ["the metadata address", "http://169.254.169.254/latest/meta-data/iam/security-credentials/", "private_address"],
    ["an IPv6 loopback", "http://[::1]/", "private_address"],
    ["an IPv4-mapped IPv6 address", "http://[::ffff:169.254.169.254]/", "private_address"],
    ["a hex IPv4 address", "http://0xa9fea9fe/", "private_address"],
    ["a name resolving privately", "http://internal.attacker.example/", "private_address"],
    ["a non-default port", "http://shop.example:6379/", "url_refused"],
    ["another scheme", "file:///etc/passwd", "url_refused"],
    ["localhost", "http://localhost/", "url_refused"],
  ])("refuses a redirect to %s", async (_label, location, expected) => {
    server.routes.set("shop.example/go", redirect(location));
    expect(await failureOf(safeFetch("http://shop.example/go", OPTIONS, network))).toBe(expected);
    // Only the first, public hop was ever connected to.
    expect(network.dialed.map((d) => d.address)).toEqual([PUBLIC_V4]);
    expect(server.requests.map((r) => r.path)).toEqual(["/go"]);
  });

  it("refuses a private address several hops in", async () => {
    server.routes.set("shop.example/1", redirect("/2"));
    server.routes.set("shop.example/2", redirect("http://www.shop.example/3"));
    server.routes.set("www.shop.example/3", redirect("http://loopback.attacker.example/"));
    expect(await failureOf(safeFetch("http://shop.example/1", OPTIONS, network))).toBe("private_address");
    expect(network.dialed.map((d) => d.address)).toEqual([PUBLIC_V4, PUBLIC_V4, PUBLIC_V4_B]);
  });

  it(`stops after ${MAX_REDIRECTS} redirects`, async () => {
    for (let i = 0; i < 10; i++) server.routes.set(`shop.example/r${i}`, redirect(`/r${i + 1}`));
    server.routes.set(`shop.example/r${MAX_REDIRECTS}`, html("reachable in exactly the limit"));
    // Exactly MAX_REDIRECTS redirects is fine...
    await expect(safeFetch("http://shop.example/r0", OPTIONS, network)).resolves.toBeTruthy();
    // ...one more is not.
    server.routes.set(`shop.example/r${MAX_REDIRECTS}`, redirect(`/r${MAX_REDIRECTS + 1}`));
    expect(await failureOf(safeFetch("http://shop.example/r0", OPTIONS, network))).toBe("too_many_redirects");
  });

  it("refuses a redirect loop", async () => {
    server.routes.set("shop.example/loop", redirect("/loop"));
    expect(await failureOf(safeFetch("http://shop.example/loop", OPTIONS, network))).toBe("too_many_redirects");
  });

  it("refuses a redirect without a location", async () => {
    server.routes.set("shop.example/x", (_req, res) => res.writeHead(302).end());
    expect(await failureOf(safeFetch("http://shop.example/x", OPTIONS, network))).toBe("http_status");
  });
});

describe("DNS rebinding", () => {
  it("connects to the address it vetted, even if DNS would now answer differently", async () => {
    server.routes.set("shop.example/p", html("pinned"));
    const original = network.resolve.bind(network);
    let calls = 0;
    // First answer public; every later answer private (a rebinding attack).
    network.resolve = async (host) => {
      calls++;
      if (calls === 1) return original(host);
      return [{ address: "127.0.0.1", family: 4 }];
    };
    const result = await safeFetch("http://shop.example/p", OPTIONS, network);
    expect(new TextDecoder().decode(result.body)).toBe("pinned");
    // Our resolver was asked once; the connection used the vetted answer.
    expect(calls).toBe(1);
    expect(network.dialed).toEqual([{ address: PUBLIC_V4, family: 4 }]);
  });

  it("re-resolves on a redirect to the same host, and refuses if it now answers privately", async () => {
    server.routes.set("shop.example/a", redirect("/b"));
    server.routes.set("shop.example/b", html("should not be reached"));
    const original = network.resolve.bind(network);
    let calls = 0;
    network.resolve = async (host) => (++calls === 1 ? original(host) : [{ address: "169.254.169.254", family: 4 }]);
    expect(await failureOf(safeFetch("http://shop.example/a", OPTIONS, network))).toBe("private_address");
    expect(server.requests.map((r) => r.path)).toEqual(["/a"]);
  });
});

describe("size caps abort the download", () => {
  it("refuses a declared Content-Length over the cap without reading it", async () => {
    server.routes.set("shop.example/big", (_req, res) => {
      res.writeHead(200, { "content-type": "text/html", "content-length": String(OPTIONS.maxBytes + 1) });
      res.write("x".repeat(1000));
      // Never finishes: the fetcher must not wait for it.
    });
    expect(await failureOf(safeFetch("http://shop.example/big", OPTIONS, network))).toBe("too_large");
  });

  it("aborts a chunked body as soon as it passes the cap", async () => {
    let written = 0;
    let stopped = false;
    server.routes.set("shop.example/stream", (_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      const chunk = "y".repeat(16 * 1024);
      const timer = setInterval(() => {
        if (res.destroyed || written > 10 * OPTIONS.maxBytes) {
          clearInterval(timer);
          stopped = true;
          res.end();
          return;
        }
        written += chunk.length;
        res.write(chunk);
      }, 2);
      res.on("close", () => {
        clearInterval(timer);
        stopped = true;
      });
    });
    expect(await failureOf(safeFetch("http://shop.example/stream", OPTIONS, network))).toBe("too_large");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stopped).toBe(true);
    expect(written).toBeLessThan(10 * OPTIONS.maxBytes);
  });

  it("caps the decompressed size of a gzip bomb", async () => {
    const bomb = gzipSync(Buffer.alloc(20 * 1024 * 1024, 0x61)); // 20 MB of "a", ~20 KB compressed
    server.routes.set("shop.example/bomb", (_req, res) => {
      res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip", "content-length": String(bomb.length) }).end(bomb);
    });
    expect(bomb.length).toBeLessThan(OPTIONS.maxBytes);
    expect(await failureOf(safeFetch("http://shop.example/bomb", OPTIONS, network))).toBe("too_large");
  });

  it("refuses an unknown content encoding", async () => {
    server.routes.set("shop.example/zstd", (_req, res) => {
      res.writeHead(200, { "content-type": "text/html", "content-encoding": "zstd" }).end("??");
    });
    expect(await failureOf(safeFetch("http://shop.example/zstd", OPTIONS, network))).toBe("network");
  });
});

describe("timeouts", () => {
  it("gives up on a server that never answers (idle timeout)", async () => {
    server.routes.set("shop.example/hang", () => {
      /* never responds */
    });
    const started = Date.now();
    expect(await failureOf(safeFetch("http://shop.example/hang", { ...OPTIONS, idleTimeoutMs: 200 }, network))).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("gives up on a slow drip that never goes idle (total timeout)", async () => {
    server.routes.set("shop.example/drip", (_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      const timer = setInterval(() => res.write("."), 50);
      res.on("close", () => clearInterval(timer));
    });
    const started = Date.now();
    const failure = await failureOf(safeFetch("http://shop.example/drip", { ...OPTIONS, idleTimeoutMs: 500, totalTimeoutMs: 400 }, network));
    expect(failure).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("gives up on a DNS lookup that hangs (total timeout)", async () => {
    network.resolve = () => new Promise(() => {});
    expect(await failureOf(safeFetch("http://shop.example/", { ...OPTIONS, totalTimeoutMs: 200 }, network))).toBe("timeout");
  });
});

describe("responses that aren't what was asked for", () => {
  it.each([403, 404, 429, 500, 503])("refuses status %i", async (status) => {
    server.routes.set("shop.example/s", (_req, res) => res.writeHead(status, { "content-type": "text/html" }).end("nope"));
    expect(await failureOf(safeFetch("http://shop.example/s", OPTIONS, network))).toBe("http_status");
  });

  it("refuses a content type the caller doesn't accept", async () => {
    server.routes.set("shop.example/file.pdf", (_req, res) => res.writeHead(200, { "content-type": "application/pdf" }).end("%PDF-1.7"));
    expect(await failureOf(safeFetch("http://shop.example/file.pdf", OPTIONS, network))).toBe("wrong_type");
  });

  it("reports a connection that closes mid-body", async () => {
    server.routes.set("shop.example/cut", (req, res) => {
      res.writeHead(200, { "content-type": "text/html", "content-length": "1000" });
      res.write("partial");
      setTimeout(() => req.socket.destroy(), 20);
    });
    expect(await failureOf(safeFetch("http://shop.example/cut", OPTIONS, network))).toBe("network");
  });
});
