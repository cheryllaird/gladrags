/**
 * The SSRF address checks: which IPs the link importer may connect to.
 */
import { describe, expect, it } from "vitest";
import { blockedAddressReason, isPublicAddress, parseIp } from "./address";

describe("parseIp", () => {
  it("reads IPv4 and every IPv6 spelling", () => {
    expect(parseIp("127.0.0.1")).toEqual({ version: 4, bytes: [127, 0, 0, 1] });
    expect(parseIp("::1")?.bytes).toEqual([...Array(15).fill(0), 1]);
    expect(parseIp("::")?.bytes).toEqual(Array(16).fill(0));
    expect(parseIp("fe80::")?.bytes).toEqual([0xfe, 0x80, ...Array(14).fill(0)]);
    expect(parseIp("::ffff:127.0.0.1")?.bytes).toEqual([...Array(10).fill(0), 0xff, 0xff, 127, 0, 0, 1]);
    expect(parseIp("::ffff:7f00:1")?.bytes).toEqual([...Array(10).fill(0), 0xff, 0xff, 127, 0, 0, 1]);
    expect(parseIp("2001:0db8:0000:0000:0000:0000:0000:0001")?.bytes.slice(0, 4)).toEqual([0x20, 0x01, 0x0d, 0xb8]);
    expect(parseIp("1:2:3:4:5:6:7:8")?.bytes).toEqual([0, 1, 0, 2, 0, 3, 0, 4, 0, 5, 0, 6, 0, 7, 0, 8]);
    expect(parseIp("1:2:3:4:5:6:1.2.3.4")?.bytes.slice(12)).toEqual([1, 2, 3, 4]);
  });

  it("rejects things that aren't IP addresses", () => {
    for (const text of ["", "localhost", "256.0.0.1", "1.2.3", "01.2.3.4", "::g", "1::2::3", "fe80::1%eth0", "[::1]", "0x7f.0.0.1"]) {
      expect(parseIp(text), text).toBeNull();
    }
  });
});

describe("blockedAddressReason: IPv4", () => {
  it.each([
    ["0.0.0.0", "this network"],
    ["0.1.2.3", "this network"],
    ["10.0.0.1", "private"],
    ["10.255.255.255", "private"],
    ["100.64.0.1", "carrier-grade NAT"],
    ["100.127.255.254", "carrier-grade NAT"],
    ["127.0.0.1", "loopback"],
    ["127.255.255.254", "loopback"],
    ["169.254.169.254", "link-local / cloud metadata"],
    ["169.254.0.1", "link-local / cloud metadata"],
    ["172.16.0.1", "private"],
    ["172.31.255.255", "private"],
    ["192.0.0.170", "IETF protocol assignments"],
    ["192.0.2.1", "documentation"],
    ["192.88.99.1", "6to4 relay"],
    ["192.168.0.1", "private"],
    ["192.168.255.255", "private"],
    ["198.18.0.1", "benchmarking"],
    ["198.19.255.255", "benchmarking"],
    ["198.51.100.7", "documentation"],
    ["203.0.113.9", "documentation"],
    ["224.0.0.1", "multicast"],
    ["239.255.255.250", "multicast"],
    ["240.0.0.1", "reserved / broadcast"],
    ["255.255.255.255", "reserved / broadcast"],
  ])("refuses %s (%s)", (address, reason) => {
    expect(blockedAddressReason(address)).toBe(reason);
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each([
    "93.184.215.14",
    "8.8.8.8",
    "1.1.1.1",
    "151.101.1.140",
    // Just outside the private and special ranges.
    "9.255.255.255",
    "11.0.0.0",
    "100.63.255.255",
    "100.128.0.0",
    "126.255.255.255",
    "128.0.0.0",
    "169.253.255.255",
    "169.255.0.0",
    "172.15.255.255",
    "172.32.0.0",
    "192.167.255.255",
    "192.169.0.0",
    "198.17.255.255",
    "198.20.0.0",
    "223.255.255.255",
  ])("allows public %s", (address) => {
    expect(blockedAddressReason(address)).toBeNull();
  });
});

describe("blockedAddressReason: IPv6", () => {
  it.each([
    ["::", "not a global IPv6 address"],
    ["::1", "not a global IPv6 address"],
    ["0:0:0:0:0:0:0:1", "not a global IPv6 address"],
    // IPv4-mapped and IPv4-compatible forms of private and public addresses alike
    ["::ffff:127.0.0.1", "not a global IPv6 address"],
    ["::ffff:7f00:1", "not a global IPv6 address"],
    ["::ffff:169.254.169.254", "not a global IPv6 address"],
    ["::ffff:10.0.0.1", "not a global IPv6 address"],
    ["::ffff:93.184.215.14", "not a global IPv6 address"],
    ["::127.0.0.1", "not a global IPv6 address"],
    ["::ffff:0:127.0.0.1", "not a global IPv6 address"],
    // NAT64 can reach any IPv4 address
    ["64:ff9b::a9fe:a9fe", "not a global IPv6 address"],
    ["64:ff9b::169.254.169.254", "not a global IPv6 address"],
    // unique local fc00::/7
    ["fc00::1", "not a global IPv6 address"],
    ["fd12:3456:789a::1", "not a global IPv6 address"],
    // link-local fe80::/10
    ["fe80::1", "not a global IPv6 address"],
    ["febf:ffff::1", "not a global IPv6 address"],
    // site-local (deprecated) and multicast
    ["fec0::1", "not a global IPv6 address"],
    ["ff02::1", "not a global IPv6 address"],
    // AWS IMDS over IPv6 is fd00:ec2::254
    ["fd00:ec2::254", "not a global IPv6 address"],
    // tunnels to IPv4 addresses of an attacker's choosing
    ["2002:7f00:1::", "6to4"],
    ["2002:a9fe:a9fe::1", "6to4"],
    ["2001:0:4136:e378:8000:63bf:3fff:fdd2", "IETF protocol assignments (includes Teredo)"],
    ["2001:db8::1", "documentation"],
    ["3fff::1", "documentation"],
  ])("refuses %s (%s)", (address, reason) => {
    expect(blockedAddressReason(address)).toBe(reason);
  });

  it.each(["2606:2800:21f:cb07:6820:80da:af6b:8b2c", "2a00:1450:4009:81f::200e", "2001:4860:4860::8888", "2400:cb00::1"])(
    "allows public %s",
    (address) => {
      expect(blockedAddressReason(address)).toBeNull();
    },
  );

  it("refuses zone IDs and anything unparseable", () => {
    expect(blockedAddressReason("fe80::1%25eth0")).toBe("not an IP address");
    expect(blockedAddressReason("example.com")).toBe("not an IP address");
    expect(blockedAddressReason("")).toBe("not an IP address");
  });
});
