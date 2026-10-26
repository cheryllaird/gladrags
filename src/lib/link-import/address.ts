/**
 * Which IP addresses the link importer may connect to. Part of the SSRF
 * defence (see safe-fetch.ts): every address a hostname resolves to is
 * checked here before connecting, on the first request and on every
 * redirect.
 *
 * IPv4: everything is allowed except the special-purpose ranges below
 * (loopback, private, link-local and cloud metadata, carrier-grade NAT,
 * multicast, documentation, benchmarking, reserved...).
 *
 * IPv6: only global unicast (2000::/3) is allowed, minus its special
 * ranges. That rules out loopback (::1), unspecified (::), unique local
 * (fc00::/7), link-local (fe80::/10), multicast (ff00::/8), IPv4-mapped
 * (::ffff:0:0/96), IPv4-compatible and NAT64 (64:ff9b::/96) in one go.
 * 6to4 (2002::/16) and Teredo (2001::/32) can tunnel to an IPv4 address of
 * the attacker's choosing, so they're refused too.
 */
import { isIPv4, isIPv6 } from "node:net";

export type ParsedIp = { version: 4; bytes: number[] } | { version: 6; bytes: number[] };

interface Range {
  bytes: number[];
  prefix: number;
  label: string;
}

function v4(cidr: string, label: string): Range {
  const [address, prefix] = cidr.split("/");
  return { bytes: address!.split(".").map(Number), prefix: Number(prefix), label };
}

function v6(cidr: string, label: string): Range {
  const [address, prefix] = cidr.split("/");
  const parsed = parseIPv6(address!);
  if (!parsed) throw new Error(`Bad range ${cidr}`);
  return { bytes: parsed, prefix: Number(prefix), label };
}

/** IANA IPv4 special-purpose ranges (RFC 6890 and updates), plus multicast and reserved. */
const BLOCKED_V4: readonly Range[] = [
  v4("0.0.0.0/8", "this network"),
  v4("10.0.0.0/8", "private"),
  v4("100.64.0.0/10", "carrier-grade NAT"),
  v4("127.0.0.0/8", "loopback"),
  v4("169.254.0.0/16", "link-local / cloud metadata"),
  v4("172.16.0.0/12", "private"),
  v4("192.0.0.0/24", "IETF protocol assignments"),
  v4("192.0.2.0/24", "documentation"),
  v4("192.31.196.0/24", "AS112"),
  v4("192.52.193.0/24", "AMT"),
  v4("192.88.99.0/24", "6to4 relay"),
  v4("192.168.0.0/16", "private"),
  v4("192.175.48.0/24", "AS112"),
  v4("198.18.0.0/15", "benchmarking"),
  v4("198.51.100.0/24", "documentation"),
  v4("203.0.113.0/24", "documentation"),
  v4("224.0.0.0/4", "multicast"),
  v4("240.0.0.0/4", "reserved / broadcast"),
];

const GLOBAL_UNICAST_V6 = v6("2000::/3", "global unicast");

const BLOCKED_V6: readonly Range[] = [
  v6("2001::/23", "IETF protocol assignments (includes Teredo)"),
  v6("2001:db8::/32", "documentation"),
  v6("2002::/16", "6to4"),
  v6("3fff::/20", "documentation"),
];

function inRange(bytes: readonly number[], range: Range): boolean {
  let bits = range.prefix;
  for (let i = 0; bits > 0; i++, bits -= 8) {
    const mask = bits >= 8 ? 0xff : (0xff << (8 - bits)) & 0xff;
    if ((bytes[i]! & mask) !== (range.bytes[i]! & mask)) return false;
  }
  return true;
}

function parseIPv4(text: string): number[] | null {
  if (!isIPv4(text)) return null;
  return text.split(".").map(Number);
}

/** 16 bytes, or null. Zone IDs (fe80::1%eth0) aren't accepted. */
function parseIPv6(text: string): number[] | null {
  if (!isIPv6(text) || text.includes("%")) return null;
  let head = text;
  let tailV4: number[] = [];
  // A trailing dotted IPv4 part, as in ::ffff:127.0.0.1.
  const lastColon = head.lastIndexOf(":");
  const maybeV4 = head.slice(lastColon + 1);
  if (maybeV4.includes(".")) {
    const parsed = parseIPv4(maybeV4);
    if (!parsed) return null;
    tailV4 = parsed;
    head = head.slice(0, lastColon + 1) + "0:0"; // placeholder groups, replaced below
  }
  const [left, right] = head.includes("::") ? head.split("::") : [head, undefined];
  const leftGroups = left ? left.split(":") : [];
  const rightGroups = right ? right.split(":") : [];
  const missing = 8 - leftGroups.length - rightGroups.length;
  if (right === undefined && missing !== 0) return null;
  const groups = [...leftGroups, ...Array<string>(right === undefined ? 0 : missing).fill("0"), ...rightGroups];
  if (groups.length !== 8) return null;
  const bytes: number[] = [];
  for (const group of groups) {
    const value = parseInt(group, 16);
    if (!/^[0-9a-f]{1,4}$/i.test(group) || Number.isNaN(value)) return null;
    bytes.push(value >> 8, value & 0xff);
  }
  if (tailV4.length) bytes.splice(12, 4, ...tailV4);
  return bytes;
}

/** Parse an IP address in its usual text form (no brackets). Null if it isn't one. */
export function parseIp(text: string): ParsedIp | null {
  const four = parseIPv4(text);
  if (four) return { version: 4, bytes: four };
  const six = parseIPv6(text);
  if (six) return { version: 6, bytes: six };
  return null;
}

/**
 * Why the importer must not connect to this address, or null if it's a
 * public address. Anything that doesn't parse is refused.
 */
export function blockedAddressReason(address: string): string | null {
  const ip = parseIp(address);
  if (!ip) return "not an IP address";
  if (ip.version === 4) {
    return BLOCKED_V4.find((range) => inRange(ip.bytes, range))?.label ?? null;
  }
  if (!inRange(ip.bytes, GLOBAL_UNICAST_V6)) return "not a global IPv6 address";
  return BLOCKED_V6.find((range) => inRange(ip.bytes, range))?.label ?? null;
}

export function isPublicAddress(address: string): boolean {
  return blockedAddressReason(address) === null;
}
