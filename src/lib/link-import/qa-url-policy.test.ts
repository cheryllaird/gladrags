/**
 * QA: adversarial URL and address spellings for the link importer's SSRF
 * checks. Pure checks, no network. Complements url-policy.test.ts and
 * address.test.ts with the bypass tricks from the QA brief.
 */
import { describe, expect, it } from "vitest";
import { blockedAddressReason, isPublicAddress } from "./address";
import { UrlPolicyError, checkFetchableUrl } from "./url-policy";

function problem(url: string, base?: string): string | null {
  try {
    checkFetchableUrl(url, base ? new URL(base) : undefined);
    return null;
  } catch (error) {
    if (error instanceof UrlPolicyError) return error.problem;
    throw error;
  }
}

describe("odd IPv4 spellings are normalised and refused", () => {
  it.each([
    "http://2130706433/",
    "http://0x7f.1/",
    "http://127.1/",
    "http://0177.0.0.1/",
    "http://0x7f.0x0.0x0.0x1/",
    "http://0177.1/",
    "http://017700000001/",
    "http://127.000.000.001/",
    "http://%31%32%37.0.0.1/", // percent-encoded digits
    "http://１２７.０.０.１/", // full-width digits
    "http://127。0。0。1/", // ideographic full stops
    "http://0/",
    "http://0.0.0.0/",
    "http://3232235777/", // 192.168.1.1
    "http://0xa9.0xfe.0xa9.0xfe/", // 169.254.169.254
    "http://2852039166/", // 169.254.169.254
    "http://100.100.100.200/", // Alibaba metadata, inside CGNAT
    "http://255.255.255.255/",
    "http://224.0.0.1/",
  ])("%s", (url) => {
    expect(problem(url)).toBe("private_address");
  });

  it("an IPv4 number past 32 bits is not a URL at all", () => {
    expect(problem("http://4294967296/")).toBe("invalid");
  });
});

describe("IPv6 literals", () => {
  it.each([
    "http://[::]/",
    "http://[::1]/",
    "http://[0:0:0:0:0:0:0:1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[0:0:0:0:0:ffff:7f00:1]/",
    "http://[::ffff:169.254.169.254]/",
    "http://[::127.0.0.1]/", // IPv4-compatible
    "http://[64:ff9b::7f00:1]/", // NAT64 to loopback
    "http://[64:ff9b:1::a9fe:a9fe]/", // local-use NAT64
    "http://[2002:7f00:1::]/", // 6to4 wrapping 127.0.0.1
    "http://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/", // Teredo
    "http://[fc00::1]/",
    "http://[fd12:3456::1]/",
    "http://[fe80::1]/",
    "http://[fec0::1]/", // deprecated site-local
    "http://[ff02::1]/",
    "http://[fd00:ec2::254]/", // AWS IMDS over IPv6
    "http://[100::1]/", // discard-only
  ])("%s is refused", (url) => {
    expect(problem(url)).toBe("private_address");
  });

  it("a zone ID can't be smuggled in (the URL parser refuses it)", () => {
    expect(problem("http://[fe80::1%25eth0]/")).toBe("invalid");
    expect(problem("http://[fe80::1%eth0]/")).toBe("invalid");
    expect(problem("http://[::1%251]/")).toBe("invalid");
    // And the address checker refuses one if it ever arrives from DNS.
    expect(blockedAddressReason("fe80::1%eth0")).not.toBeNull();
    expect(blockedAddressReason("2606:2800:21f:cb07:6820:80da:af6b:8b2c%eth0")).not.toBeNull();
  });

  it("a public IPv6 literal is allowed", () => {
    expect(problem("http://[2606:2800:21f:cb07:6820:80da:af6b:8b2c]/")).toBeNull();
  });
});

describe("host names that mean this machine", () => {
  it.each([
    "http://localhost./",
    "http://LOCALHOST/",
    "http://LocalHost./",
    "http://ⓛocalhost/", // circled letter, mapped by IDNA
    "http://loca\u00adlhost/", // soft hyphen, removed by IDNA
    "http://ｌｏｃａｌｈｏｓｔ/", // full-width
    "http://localhost%2e/", // percent-encoded trailing dot
    "http://foo.localhost./",
    "http://printer.local./",
    "http://metadata.google.internal./",
    "http://METADATA.GOOGLE.INTERNAL/",
    "http://metadata/",
    "http://metadata./", // dotless once the trailing dot goes
  ])("%s is refused", (url) => {
    expect(problem(url)).toBe("hostname");
  });

  // QA finding (low, defence in depth), fixed: bareHostname used to strip
  // only ONE trailing dot, so "localhost.." slipped past the name blocklist.
  it.each(["http://localhost../", "http://printer.local../", "http://metadata.google.internal../", "http://foo.localhost.../"])(
    "%s (several trailing dots) is refused",
    (url) => {
      expect(problem(url)).toBe("hostname");
    },
  );

  it("names that only look like IPs go to DNS, where the address is checked", () => {
    // Accepted by the URL policy; safe-fetch then refuses the private answer.
    expect(problem("http://127.0.0.1.nip.io/")).toBeNull();
  });
});

describe("userinfo, fragments and backslashes", () => {
  it("evil.com@127.0.0.1 is credentials pointing at loopback, refused", () => {
    // Either reason is fine; it must not pass.
    expect(problem("http://evil.com@127.0.0.1/")).not.toBeNull();
    expect(problem("http://shop.example%2f@127.0.0.1/")).not.toBeNull();
    expect(problem("http://:@shop.example/")).toBeNull(); // empty userinfo is dropped by the parser
  });

  it("127.0.0.1#@evil.com targets 127.0.0.1, and is refused", () => {
    expect(problem("http://127.0.0.1#@evil.com/")).toBe("private_address");
    expect(problem("http://127.0.0.1?@evil.com/")).toBe("private_address");
  });

  it("a backslash ends the host, as in browsers", () => {
    expect(problem("http://127.0.0.1\\@shop.example/")).toBe("private_address");
    // shop.example\127.0.0.1 targets shop.example: the IP is only a path.
    expect(checkFetchableUrl("http://shop.example\\127.0.0.1/").hostname).toBe("shop.example");
    expect(problem("http:\\\\127.0.0.1\\x")).toBe("private_address");
    expect(problem("http:/127.0.0.1/")).toBe("private_address");
    expect(problem("http:127.0.0.1/")).toBe("private_address");
  });

  it("the fragment is dropped from the URL that gets fetched", () => {
    expect(checkFetchableUrl("http://shop.example/p#@127.0.0.1").href).toBe("http://shop.example/p");
  });
});

describe("redirect Location values (resolved against the page)", () => {
  const base = "https://shop.example/p/1";

  it.each([
    ["//127.0.0.1/", "private_address"],
    ["///127.0.0.1/", "private_address"],
    ["\\\\127.0.0.1\\", "private_address"],
    ["/\\127.0.0.1/", "private_address"],
    ["//[::1]/", "private_address"],
    ["//localhost/", "hostname"],
    ["//shop.example:8080/", "port"],
    ["http://shop.example:443/", "port"],
    ["https://shop.example:80/", "port"],
    ["file:///etc/passwd", "not_http"],
    ["data:text/html,<meta>", "not_http"],
    ["javascript:alert(1)", "not_http"],
    ["ftp://shop.example/x", "not_http"],
    ["gopher://127.0.0.1:6379/_INFO", "not_http"],
    ["ws://shop.example/", "not_http"],
    ["blob:https://shop.example/uuid", "not_http"],
    ["//user:pw@shop.example/", "credentials"],
  ])("%s -> %s", (location, expected) => {
    expect(problem(location, base)).toBe(expected);
  });

  it("relative paths stay on the same host", () => {
    expect(checkFetchableUrl("../x?y", new URL(base)).href).toBe("https://shop.example/x?y");
    expect(checkFetchableUrl("?q=1", new URL(base)).href).toBe("https://shop.example/p/1?q=1");
  });
});

describe("addresses that DNS might return", () => {
  it.each([
    "0.0.0.0",
    "127.0.0.53",
    "169.254.169.254",
    "100.64.0.1",
    "198.18.0.1",
    "::",
    "::1",
    "::ffff:10.0.0.1",
    "::ffff:a00:1",
    "64:ff9b::a00:1",
    "fd00::1",
    "fe80::1",
    "2001:db8::1",
    "2002:a00:1::",
  ])("%s is not public", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(["", "localhost", "127.1", "0x7f000001", "2130706433", "1.2.3", "01.02.03.04", "1.2.3.4.5", " 1.2.3.4", "[::1]"])(
    "%j isn't an address in canonical form, so it's refused",
    (address) => {
      expect(isPublicAddress(address)).toBe(false);
    },
  );
});
