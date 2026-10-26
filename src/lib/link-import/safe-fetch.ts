/**
 * Fetching a user-supplied URL from the server without letting it reach
 * anything private (SSRF). Used for the product page and the product image.
 *
 * For each request, and again for every redirect:
 * 1. The URL must pass checkFetchableUrl: http(s), default port, no
 *    credentials, a public-looking host name.
 * 2. We resolve the host name ourselves, and EVERY address it resolves to
 *    must be public (address.ts). One private address refuses the lot.
 * 3. The connection is pinned to the address we checked (the `lookup`
 *    option), so a second DNS answer (DNS rebinding) can't swap it for a
 *    private one. TLS still verifies the certificate against the host name.
 *
 * Also: GET only, at most MAX_REDIRECTS redirects, an idle timeout that
 * covers connecting and stalled responses, a total deadline, a byte cap
 * that aborts the download as soon as it's passed (after decompression
 * too), no cookies or credentials, and a plain, honest User-Agent.
 *
 * Node's http/https modules are used rather than fetch(), because fetch
 * can't be pinned to an address.
 */
import "server-only";
import { lookup as dnsLookup } from "node:dns/promises";
import http, { type IncomingMessage } from "node:http";
import https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import type { Readable } from "node:stream";
import zlib from "node:zlib";
import { blockedAddressReason } from "./address";
import { UrlPolicyError, bareHostname, checkFetchableUrl } from "./url-policy";

export const USER_AGENT = "GladRags/0.1 (link import; fetches one product page a user shared with the app)";
export const MAX_REDIRECTS = 3;

export type FetchFailure =
  | "url_refused" // failed checkFetchableUrl
  | "private_address" // resolved to an address we won't connect to
  | "dns_failed"
  | "timeout"
  | "too_large"
  | "too_many_redirects"
  | "http_status" // not 2xx (403 from a bot wall, 404...)
  | "wrong_type" // e.g. a PDF where a page was expected
  | "network";

export class SafeFetchError extends Error {
  constructor(
    readonly failure: FetchFailure,
    message: string,
  ) {
    super(message);
    this.name = "SafeFetchError";
  }
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/**
 * Network access, injectable for tests. `resolve` looks up every address
 * for a host name. `dial` says where to actually open the TCP connection
 * for an address we vetted: identity in production; tests point it at a
 * local server so the real address checks still run on the vetted address.
 */
export interface NetworkDeps {
  resolve(hostname: string): Promise<ResolvedAddress[]>;
  dial?(address: ResolvedAddress, port: number): { address: string; family: 4 | 6; port: number };
}

export const systemNetwork: NetworkDeps = {
  async resolve(hostname) {
    const results = await dnsLookup(hostname, { all: true, verbatim: true });
    return results.map((r) => ({ address: r.address, family: r.family === 6 ? 6 : 4 }));
  },
};

export interface SafeFetchOptions {
  /** Abort once the (decompressed) body passes this many bytes. */
  maxBytes: number;
  /** Accept header. */
  accept: string;
  /** Content-type check on the final response; a missing type is passed as null. */
  acceptType(contentType: string | null): boolean;
  /** No bytes for this long (connecting included): give up. */
  idleTimeoutMs: number;
  /** The whole fetch, redirects included. */
  totalTimeoutMs: number;
  maxRedirects?: number;
}

export interface SafeFetchResult {
  /** Where the content came from, after redirects. */
  finalUrl: URL;
  contentType: string | null;
  body: Uint8Array;
}

/** The checked URL and the vetted address to pin the connection to. */
async function vet(url: URL, network: NetworkDeps): Promise<ResolvedAddress> {
  const host = bareHostname(url);
  const literal = isIP(host);
  let addresses: ResolvedAddress[];
  if (literal) {
    addresses = [{ address: host, family: literal === 6 ? 6 : 4 }];
  } else {
    try {
      addresses = await network.resolve(host);
    } catch {
      throw new SafeFetchError("dns_failed", "Couldn't find that site");
    }
  }
  if (addresses.length === 0) throw new SafeFetchError("dns_failed", "Couldn't find that site");
  for (const { address } of addresses) {
    const reason = blockedAddressReason(address);
    if (reason) throw new SafeFetchError("private_address", `That site isn't on the public internet (${reason})`);
  }
  return addresses[0]!;
}

/** A lookup that always answers with the vetted address, whatever DNS says now. */
function pinnedLookup(target: { address: string; family: 4 | 6 }): LookupFunction {
  return ((_hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
    if (options?.all) callback(null, [{ address: target.address, family: target.family }]);
    else callback(null, target.address, target.family);
  }) as LookupFunction;
}

function headerValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

type Hop = { kind: "redirect"; location: string } | { kind: "body"; result: SafeFetchResult };

/** One request to one vetted address. Resolves with a redirect target or the capped body. */
function requestOnce(url: URL, pinned: ResolvedAddress, network: NetworkDeps, options: SafeFetchOptions, signal: AbortSignal): Promise<Hop> {
  const defaultPort = url.protocol === "https:" ? 443 : 80;
  const target = network.dial ? network.dial(pinned, defaultPort) : { ...pinned, port: defaultPort };
  const transport = url.protocol === "https:" ? https : http;

  return new Promise<Hop>((resolve, reject) => {
    let settled = false;
    const fail = (error: SafeFetchError) => {
      if (settled) return;
      settled = true;
      request.destroy();
      reject(error);
    };

    const request = transport.request(
      {
        protocol: url.protocol,
        hostname: bareHostname(url),
        port: target.port,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        // A fresh connection every time: no pooled socket to another host.
        agent: false,
        lookup: pinnedLookup(target),
        headers: {
          "user-agent": USER_AGENT,
          accept: options.accept,
          "accept-encoding": "gzip, deflate, br",
          "accept-language": "en-GB,en;q=0.8",
        },
        timeout: options.idleTimeoutMs,
        signal,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (REDIRECT_STATUSES.has(status)) {
          const location = headerValue(response.headers.location);
          response.resume();
          if (!location) return fail(new SafeFetchError("http_status", `Redirect (${status}) without a location`));
          settled = true;
          request.destroy();
          return resolve({ kind: "redirect", location });
        }
        if (status < 200 || status > 299) {
          response.resume();
          return fail(new SafeFetchError("http_status", `The site answered ${status}`));
        }
        const contentType = headerValue(response.headers["content-type"]);
        if (!options.acceptType(contentType)) {
          response.resume();
          return fail(new SafeFetchError("wrong_type", `Unexpected content type ${contentType ?? "(none)"}`));
        }
        const declared = Number(headerValue(response.headers["content-length"]));
        const encoding = (headerValue(response.headers["content-encoding"]) ?? "identity").trim().toLowerCase();
        // Compressed bodies can grow a lot; the cap below applies after decompression.
        if (encoding === "identity" && Number.isFinite(declared) && declared > options.maxBytes) {
          response.resume();
          return fail(new SafeFetchError("too_large", "The response is too large"));
        }
        let stream: Readable;
        try {
          stream = decoded(response, encoding);
        } catch (error) {
          response.resume();
          return fail(error instanceof SafeFetchError ? error : new SafeFetchError("network", "Couldn't read the response"));
        }

        const chunks: Buffer[] = [];
        let total = 0;
        stream.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > options.maxBytes) {
            stream.destroy();
            response.destroy();
            return fail(new SafeFetchError("too_large", "The response is too large"));
          }
          chunks.push(chunk);
        });
        stream.on("error", () => fail(new SafeFetchError("network", "The connection failed while reading")));
        response.on("error", () => fail(new SafeFetchError("network", "The connection failed while reading")));
        response.on("close", () => {
          if (!response.complete) fail(new SafeFetchError("network", "The connection closed early"));
        });
        stream.on("end", () => {
          if (settled) return;
          settled = true;
          const body = Buffer.concat(chunks);
          resolve({
            kind: "body",
            result: { finalUrl: url, contentType, body: new Uint8Array(body.buffer, body.byteOffset, body.byteLength) },
          });
        });
      },
    );
    request.on("timeout", () => fail(new SafeFetchError("timeout", "The site took too long to answer")));
    request.on("error", (error) => {
      if (signal.aborted) return fail(new SafeFetchError("timeout", "The site took too long to answer"));
      fail(error instanceof SafeFetchError ? error : new SafeFetchError("network", "Couldn't connect to the site"));
    });
    request.end();
  });
}

function decoded(response: IncomingMessage, encoding: string): Readable {
  switch (encoding) {
    case "identity":
    case "":
      return response;
    case "gzip":
    case "x-gzip":
      return response.pipe(zlib.createGunzip());
    case "deflate":
      return response.pipe(zlib.createInflate());
    case "br":
      return response.pipe(zlib.createBrotliDecompress());
    default:
      throw new SafeFetchError("network", `Unsupported content encoding ${encoding}`);
  }
}

/**
 * GET a URL safely (see the top of this file). Throws SafeFetchError for
 * every kind of failure, including a refused URL.
 */
export async function safeFetch(input: string | URL, options: SafeFetchOptions, network: NetworkDeps = systemNetwork): Promise<SafeFetchResult> {
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), options.totalTimeoutMs);
  const timedOut = new Promise<never>((_, reject) => {
    controller.signal.addEventListener("abort", () => reject(new SafeFetchError("timeout", "The site took too long to answer")), {
      once: true,
    });
  });
  timedOut.catch(() => {}); // handled through the race below

  const check = (text: string, base?: URL): URL => {
    try {
      return checkFetchableUrl(text, base);
    } catch (error) {
      if (error instanceof UrlPolicyError) {
        throw new SafeFetchError(error.problem === "private_address" ? "private_address" : "url_refused", error.message);
      }
      throw error;
    }
  };

  try {
    let url = check(typeof input === "string" ? input : input.href);
    for (let redirects = 0; ; redirects++) {
      // DNS can hang; the deadline covers it too.
      const pinned = await Promise.race([vet(url, network), timedOut]);
      const hop = await Promise.race([requestOnce(url, pinned, network, options, controller.signal), timedOut]);
      if (hop.kind === "body") return hop.result;
      if (redirects >= maxRedirects) throw new SafeFetchError("too_many_redirects", "The link redirects too many times");
      // Every redirect target goes through the same checks, DNS included.
      url = check(hop.location, url);
    }
  } finally {
    clearTimeout(deadline);
    controller.abort();
  }
}
