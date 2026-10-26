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

export function getClientBackgroundRemover(): BackgroundRemover {
  if (usesTestFakeRemover()) {
    fake ??= new FakeBackgroundRemover();
    return fake;
  }
  return getBackgroundRemover();
}
