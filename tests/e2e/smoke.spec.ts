import { expect, test } from "@playwright/test";

// Smoke test: the app boots in mock mode on a 390 px phone viewport and is
// installable. The qa agent adds the five core journeys alongside this.

test("home page opens the wardrobe on a phone-sized screen", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/wardrobe$/);
  await expect(page.getByRole("heading", { name: "Wardrobe" })).toBeVisible();
  expect(page.viewportSize()?.width).toBe(390);

  // Nothing should overflow sideways on a phone.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("the web app manifest is served", async ({ request }) => {
  const res = await request.get("/manifest.webmanifest");
  expect(res.ok()).toBe(true);
  const manifest = await res.json();
  expect(manifest).toMatchObject({ name: "GladRags", display: "standalone", start_url: "/" });
});

test("sign-in asks for an email, then a code", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill("cheryl@example.com");
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByLabel("Code from the email")).toBeVisible();
});

test("the mock API serves the wardrobe", async ({ request }) => {
  const res = await request.get("/api/items");
  expect(res.ok()).toBe(true);
  const body = await res.json();
  expect(body.items.length).toBeGreaterThan(0);
});
