/**
 * The one place the add-item screens get their background remover from:
 * ingestion's in-browser U²-Netp model (src/lib/images).
 *
 * Test hook: end-to-end tests that need a predictable cut-out set
 * `window.__GLADRAGS_TEST_REMOVER__ = "fake"` before the page loads (see
 * tests/e2e/helpers.ts, fakeBackgroundRemoverForFile). The real model has its own browser tests in
 * tests/e2e/background-removal.spec.ts. The hook only changes the user's own
 * cut-outs, so it carries no security risk.
 */
import { FakeBackgroundRemover, getBackgroundRemover, type BackgroundRemover } from "@/lib/images";

let fake: FakeBackgroundRemover | undefined;

export function usesTestFakeRemover(): boolean {
  return (globalThis as { __GLADRAGS_TEST_REMOVER__?: string }).__GLADRAGS_TEST_REMOVER__ === "fake";
}

/**
 * Test hook for the fake only: `window.__GLADRAGS_TEST_REMOVER_RESULT__`,
 * a base64 PNG, makes the fake return that image instead of its 1×1
 * transparent pixel (e.g. so a collage test can see a cut-out swapped in).
 */
function testFakeResult(): Blob | undefined {
  const base64 = (globalThis as { __GLADRAGS_TEST_REMOVER_RESULT__?: string }).__GLADRAGS_TEST_REMOVER_RESULT__;
  if (typeof base64 !== "string" || base64 === "") return undefined;
  return new Blob([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], { type: "image/png" });
}

export function getClientBackgroundRemover(): BackgroundRemover {
  if (usesTestFakeRemover()) {
    fake ??= new FakeBackgroundRemover({ result: testFakeResult() });
    return fake;
  }
  return getBackgroundRemover();
}
