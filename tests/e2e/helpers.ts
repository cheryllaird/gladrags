import { test, type Page } from "@playwright/test";

/**
 * Make the add-item screens use FakeBackgroundRemover (a fixed transparent
 * PNG) instead of the real in-browser model, so photo tests get a
 * predictable cut-out. See src/lib/client/background-remover.ts.
 */
export async function installFakeBackgroundRemover(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { __GLADRAGS_TEST_REMOVER__?: string }).__GLADRAGS_TEST_REMOVER__ = "fake";
  });
}

/** Call at the top of a spec file: every test in the file uses the fake remover. */
export function fakeBackgroundRemoverForFile(): void {
  test.beforeEach(async ({ page }) => {
    await installFakeBackgroundRemover(page);
  });
}
