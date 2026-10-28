/**
 * Sign-in attempt keys: HMAC-SHA-256 with a server-only key
 * (SIGN_IN_HASH_KEY), failing closed in production without one, and IPv6
 * addresses keyed by their /64.
 */
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigError } from "@/lib/env";
import { InMemorySignInAttemptStore, assertSignInAttemptAllowed, hashEmail, hashIp, ipRateLimitKey, signInHashKey } from "./rate-limit";

const KEY = "k".repeat(40);
const request = () => new Request("http://localhost/api/auth/magic-link", { method: "POST" });

afterEach(() => vi.unstubAllEnvs());

describe("hash key (SIGN_IN_HASH_KEY)", () => {
  it("hashes with HMAC: a different key gives different hashes, and none is a plain SHA-256 of the email", () => {
    vi.stubEnv("SIGN_IN_HASH_KEY", KEY);
    const first = hashEmail("tester@example.com");
    vi.stubEnv("SIGN_IN_HASH_KEY", "z".repeat(40));
    const second = hashEmail("tester@example.com");
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).not.toBe(first);
    expect(first).not.toBe(createHash("sha256").update("gladrags:email:tester@example.com").digest("hex"));
  });

  it("fails closed with a ConfigError (server_misconfigured) in production when unset, short or padded", () => {
    vi.stubEnv("GLADRAGS_MOCK_MODE", "false");
    vi.stubEnv("NODE_ENV", "production");
    for (const value of ["", "short", ` ${KEY}`, `${KEY}\n`]) {
      vi.stubEnv("SIGN_IN_HASH_KEY", value);
      expect(() => signInHashKey()).toThrow(ConfigError);
      expect(() => hashEmail("tester@example.com")).toThrow(/SIGN_IN_HASH_KEY/);
    }
    vi.stubEnv("SIGN_IN_HASH_KEY", KEY);
    expect(signInHashKey()).toBe(KEY);
  });

  it("with no key in production, a sign-in attempt is refused before anything is stored", async () => {
    vi.stubEnv("GLADRAGS_MOCK_MODE", "false");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SIGN_IN_HASH_KEY", "");
    const store = new InMemorySignInAttemptStore();
    await expect(assertSignInAttemptAllowed(store, "magic_link", "a@example.com", request())).rejects.toBeInstanceOf(ConfigError);
    expect(store.attempts).toEqual([]);
  });

  it("uses a fixed development key in tests and mock mode when unset", () => {
    vi.stubEnv("SIGN_IN_HASH_KEY", "");
    vi.stubEnv("NODE_ENV", "test");
    expect(signInHashKey()).toMatch(/dev-only/);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("GLADRAGS_MOCK_MODE", "true");
    vi.stubEnv("GLADRAGS_E2E", "true");
    expect(signInHashKey()).toMatch(/dev-only/);
  });
});

describe("ipRateLimitKey", () => {
  it.each([
    ["203.0.113.7", "203.0.113.7"],
    ["::ffff:203.0.113.7", "203.0.113.7"],
    ["2001:db8:1:2::1", "2001:db8:1:2::/64"],
    ["2001:0DB8:0001:0002:aaaa:bbbb:cccc:dddd", "2001:db8:1:2::/64"],
    ["[2001:db8:1:2::ff]", "2001:db8:1:2::/64"],
    ["2001:db8::1", "2001:db8:0:0::/64"],
    ["::1", "0:0:0:0::/64"],
    ["64:ff9b::192.0.2.1", "64:ff9b:0:0::/64"],
    ["not an ip", "not an ip"],
  ])("%s is limited as %s", (ip, key) => {
    expect(ipRateLimitKey(ip)).toBe(key);
  });

  it("two addresses in one /64 share a hash; another /64 doesn't", () => {
    expect(hashIp("2001:db8:1:2::1")).toBe(hashIp("2001:db8:1:2:ffff::9"));
    expect(hashIp("2001:db8:1:3::1")).not.toBe(hashIp("2001:db8:1:2::1"));
  });
});
