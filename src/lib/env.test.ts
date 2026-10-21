import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigError, isMockMode } from "./env";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isMockMode", () => {
  it("is off unless GLADRAGS_MOCK_MODE is exactly 'true'", () => {
    vi.stubEnv("GLADRAGS_MOCK_MODE", "1");
    expect(isMockMode()).toBe(false);
    vi.stubEnv("GLADRAGS_MOCK_MODE", "");
    expect(isMockMode()).toBe(false);
  });

  it("is on in development and tests", () => {
    vi.stubEnv("GLADRAGS_MOCK_MODE", "true");
    vi.stubEnv("NODE_ENV", "development");
    expect(isMockMode()).toBe(true);
  });

  it.each(["preview", "production", "development"])("refuses on Vercel (VERCEL_ENV=%s), even with GLADRAGS_E2E", (vercelEnv) => {
    vi.stubEnv("GLADRAGS_MOCK_MODE", "true");
    vi.stubEnv("VERCEL_ENV", vercelEnv);
    vi.stubEnv("GLADRAGS_E2E", "true");
    expect(() => isMockMode()).toThrow(ConfigError);
  });

  it("refuses in a production build unless it's an e2e run", () => {
    vi.stubEnv("GLADRAGS_MOCK_MODE", "true");
    vi.stubEnv("NODE_ENV", "production");
    expect(() => isMockMode()).toThrow(ConfigError);
    vi.stubEnv("GLADRAGS_E2E", "true");
    expect(isMockMode()).toBe(true);
  });

  it("doesn't throw in production when mock mode is off", () => {
    vi.stubEnv("GLADRAGS_MOCK_MODE", "false");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL_ENV", "production");
    expect(isMockMode()).toBe(false);
  });
});
