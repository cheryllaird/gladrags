/**
 * Which URLs the link importer may fetch, before any DNS lookup: http or
 * https, the default port, no user name or password, and a hostname that
 * looks like a public site. The address it resolves to is checked
 * separately (address.ts), because a public-looking name can point
 * anywhere.
 */
import { isPublicAddress, parseIp } from "./address";

/** Longest URL we'll fetch (the contract's SourceUrlSchema limit). */
export const MAX_URL_LENGTH = 2048;

/** Names that always mean "this machine" or a private network. */
const LOCAL_SUFFIXES = [".localhost", ".local", ".internal", ".intranet", ".lan", ".home.arpa", ".corp", ".home"];

export type UrlProblem = "not_http" | "credentials" | "port" | "hostname" | "private_address" | "too_long" | "invalid";

export class UrlPolicyError extends Error {
  constructor(
    readonly problem: UrlProblem,
    message: string,
  ) {
    super(message);
    this.name = "UrlPolicyError";
  }
}

/** The hostname without IPv6 brackets or a trailing dot, lower-cased. */
export function bareHostname(url: URL): string {
  const host = url.hostname.toLowerCase();
  const unbracketed = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  return unbracketed.endsWith(".") ? unbracketed.slice(0, -1) : unbracketed;
}

/**
 * Parse and check a URL (absolute, or relative to `base`). Returns the
 * parsed URL without its fragment. Throws UrlPolicyError.
 *
 * The WHATWG URL parser already turns odd IPv4 spellings (2130706433,
 * 0x7f.1, 0177.0.0.1) into dotted form, so the IP check below sees them.
 */
export function checkFetchableUrl(input: string, base?: URL): URL {
  if (input.length > MAX_URL_LENGTH) throw new UrlPolicyError("too_long", "URL is too long");
  let url: URL;
  try {
    url = new URL(input, base);
  } catch {
    throw new UrlPolicyError("invalid", "Not a valid URL");
  }
  if (url.href.length > MAX_URL_LENGTH) throw new UrlPolicyError("too_long", "URL is too long");
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UrlPolicyError("not_http", "Only http and https links can be fetched");
  }
  if (url.username || url.password) {
    throw new UrlPolicyError("credentials", "Links with a user name or password aren't fetched");
  }
  // URL drops the port when it's the scheme's default (80 / 443), so any
  // port left here is a non-default one.
  if (url.port !== "") throw new UrlPolicyError("port", "Only the standard web ports are fetched");

  const host = bareHostname(url);
  const ip = parseIp(host);
  if (ip) {
    if (!isPublicAddress(host)) throw new UrlPolicyError("private_address", "That address isn't a public website");
  } else {
    // A name with no dot can be completed by the server's DNS search
    // domains into an internal name, so require a dotted public name.
    if (!host.includes(".") || host === "localhost" || LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
      throw new UrlPolicyError("hostname", "That isn't a public website");
    }
    if (!/^[a-z0-9.-]+$/.test(host)) throw new UrlPolicyError("hostname", "That isn't a valid host name");
  }

  url.hash = "";
  return url;
}
