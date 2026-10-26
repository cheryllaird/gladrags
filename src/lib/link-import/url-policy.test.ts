/**
 * Which URLs the link importer may fetch, before any DNS lookup.
 */
import { describe, expect, it } from "vitest";
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

describe("checkFetchableUrl", () => {
  it("accepts ordinary shop links and drops the fragment", () => {
    expect(checkFetchableUrl("https://www.shop.example/p/123?colour=navy#reviews").href).toBe("https://www.shop.example/p/123?colour=navy");
    expect(checkFetchableUrl("http://shop.example/").href).toBe("http://shop.example/");
    // Default ports written out are fine; URL drops them.
    expect(checkFetchableUrl("https://shop.example:443/a").href).toBe("https://shop.example/a");
    expect(checkFetchableUrl("http://shop.example:80/a").href).toBe("http://shop.example/a");
    // International names become punycode.
    expect(checkFetchableUrl("https://bücher.example/").hostname).toBe("xn--bcher-kva.example");
    // A public IP literal is allowed (it's checked like any resolved address).
    expect(checkFetchableUrl("http://93.184.215.14/p").hostname).toBe("93.184.215.14");
  });

  it("resolves relative URLs (redirects) against a base", () => {
    expect(checkFetchableUrl("/next", new URL("https://shop.example/p/1")).href).toBe("https://shop.example/next");
    expect(checkFetchableUrl("//cdn.shop.example/x.jpg", new URL("https://shop.example/")).href).toBe("https://cdn.shop.example/x.jpg");
  });

  it.each([
    ["ftp://shop.example/file", "not_http"],
    ["file:///etc/passwd", "not_http"],
    ["gopher://shop.example/", "not_http"],
    ["data:text/html,hi", "not_http"],
    ["javascript:alert(1)", "not_http"],
    ["https://user:pass@shop.example/", "credentials"],
    ["https://user@shop.example/", "credentials"],
    ["https://shop.example:8443/", "port"],
    ["http://shop.example:8080/", "port"],
    ["http://shop.example:443/", "port"],
    ["https://shop.example:80/", "port"],
    ["http://shop.example:22/", "port"],
    ["http://localhost/", "hostname"],
    ["http://LOCALHOST./", "hostname"],
    ["http://api.localhost/", "hostname"],
    ["http://printer.local/", "hostname"],
    ["http://metadata.google.internal/", "hostname"],
    ["http://router.home.arpa/", "hostname"],
    ["http://intranet/", "hostname"],
    ["http://metadata/", "hostname"],
    ["http://127.0.0.1/", "private_address"],
    ["http://127.1/", "private_address"],
    ["http://2130706433/", "private_address"],
    ["http://0x7f000001/", "private_address"],
    ["http://0177.0.0.1/", "private_address"],
    ["http://0/", "private_address"],
    ["http://169.254.169.254/latest/meta-data/", "private_address"],
    ["http://10.0.0.1/", "private_address"],
    ["http://172.16.5.4/", "private_address"],
    ["http://192.168.1.1/", "private_address"],
    ["http://100.64.0.1/", "private_address"],
    ["http://[::1]/", "private_address"],
    ["http://[::ffff:127.0.0.1]/", "private_address"],
    ["http://[::ffff:a9fe:a9fe]/", "private_address"],
    ["http://[fd00::1]/", "private_address"],
    ["http://[fe80::1]/", "private_address"],
    ["not a url", "invalid"],
    ["https://", "invalid"],
    [`https://shop.example/${"a".repeat(2100)}`, "too_long"],
  ])("refuses %s (%s)", (url, expected) => {
    expect(problem(url)).toBe(expected);
  });

  it("refuses a relative redirect to a private host", () => {
    expect(problem("//127.0.0.1/admin", "https://shop.example/")).toBe("private_address");
    expect(problem("http://[::1]:80/", "https://shop.example/")).toBe("private_address");
  });
});
