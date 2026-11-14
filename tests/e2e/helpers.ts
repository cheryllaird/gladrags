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

/**
 * Keep outfit pictures from being made (round 2), so tests about the
 * collage keep seeing it: the preview route answers with the outfit as it
 * is (GET /api/outfits/:id), whose preview stays "none", so the card shows
 * its collage with no note. Tests of the pictures themselves don't use it.
 */
export async function blockOutfitPreviews(page: Page): Promise<void> {
  await page.route(/\/api\/outfits\/[^/]+\/preview(\?.*)?$/, async (route) => {
    const url = new URL(route.request().url());
    const outfitUrl = `${url.origin}${url.pathname.replace(/\/preview$/, "")}`;
    const response = await route.fetch({ url: outfitUrl, method: "GET" });
    await route.fulfill({ response });
  });
}

/** Call at the top of a spec file about collages: no test in the file gets outfit pictures. */
export function collagesOnlyForFile(): void {
  test.beforeEach(async ({ page }) => {
    await blockOutfitPreviews(page);
  });
}
