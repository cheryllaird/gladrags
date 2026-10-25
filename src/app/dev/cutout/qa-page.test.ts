/**
 * QA tests for the /dev/cutout test bench's gate: it must be a 404 unless
 * mock mode is genuinely allowed (CONTRACTS.md, "Mock mode": refused on
 * Vercel and in a production build without GLADRAGS_E2E). The harness
 * itself is replaced with a marker so this runs in Node.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./cutout-harness", () => ({ CutoutHarness: () => "harness" }));

import CutoutDevPage from "./page";

function render(): "page" | "404" {
  try {
    const element = CutoutDevPage();
    expect(element).toBeTruthy();
    return "page";
  } catch (error) {
    const digest = (error as { digest?: string }).digest ?? "";
    if (digest.includes("404")) return "404";
    throw error;
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("/dev/cutout", () => {
  it.each([
    ["mock mode off", { GLADRAGS_MOCK_MODE: "false", NODE_ENV: "development" }],
    ["mock mode unset", { GLADRAGS_MOCK_MODE: "", NODE_ENV: "development" }],
    ["mock mode 'TRUE' (only the exact string true counts)", { GLADRAGS_MOCK_MODE: "TRUE", NODE_ENV: "development" }],
    ["production build, mock mode on, no GLADRAGS_E2E", { GLADRAGS_MOCK_MODE: "true", NODE_ENV: "production", GLADRAGS_E2E: "" }],
    ["production build, mock mode on, GLADRAGS_E2E=1 (not 'true')", { GLADRAGS_MOCK_MODE: "true", NODE_ENV: "production", GLADRAGS_E2E: "1" }],
    ["Vercel preview, mock mode on, even with GLADRAGS_E2E", { GLADRAGS_MOCK_MODE: "true", VERCEL_ENV: "preview", GLADRAGS_E2E: "true" }],
    ["Vercel production, mock mode on", { GLADRAGS_MOCK_MODE: "true", VERCEL_ENV: "production", NODE_ENV: "production" }],
  ])("is a 404 with %s", (_label, env) => {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    expect(render()).toBe("404");
  });

  it.each([
    ["mock mode in development", { GLADRAGS_MOCK_MODE: "true", NODE_ENV: "development", VERCEL_ENV: "" }],
    ["mock mode in a production build for end-to-end tests", { GLADRAGS_MOCK_MODE: "true", NODE_ENV: "production", GLADRAGS_E2E: "true", VERCEL_ENV: "" }],
  ])("is served with %s", (_label, env) => {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    expect(render()).toBe("page");
  });
});
