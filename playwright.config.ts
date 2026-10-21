import { defineConfig } from "@playwright/test";

const PORT = Number(process.env.PLAYWRIGHT_PORT ?? 3100);
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${PORT}`;
/**
 * Optional: a Chromium binary to use instead of Playwright's own download,
 * for machines with a pre-installed browser of a different build. CI leaves
 * it unset and uses `playwright install`.
 */
const CHROMIUM_EXECUTABLE = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined;
/**
 * PLAYWRIGHT_USE_BUILD=true tests the production build (`pnpm start`; run
 * `pnpm build` first), as CI does. Otherwise the dev server is used.
 * GLADRAGS_E2E=true is what lets mock mode run in a production build.
 */
const USE_BUILD = process.env.PLAYWRIGHT_USE_BUILD === "true";

/**
 * Journey tests run on a 390 px wide phone viewport (CLAUDE.md: mobile first)
 * against the app in mock mode, so no Supabase or AI credentials are needed.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "mobile-chromium",
      use: {
        browserName: "chromium",
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
        launchOptions: CHROMIUM_EXECUTABLE ? { executablePath: CHROMIUM_EXECUTABLE } : {},
      },
    },
  ],
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : {
        command: USE_BUILD ? `pnpm start --port ${PORT}` : `pnpm dev --port ${PORT}`,
        url: BASE_URL,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        env: { GLADRAGS_MOCK_MODE: "true", GLADRAGS_E2E: "true" },
      },
});
