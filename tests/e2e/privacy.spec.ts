import { expect, test } from "@playwright/test";

// The tester privacy note at /privacy (spec: Privacy and security), at
// 390 px against mock mode. That signed-out visitors can reach it (the
// proxy's public paths) is covered by src/proxy.test.ts, since mock mode
// skips the proxy's sign-in redirect.

test.describe("privacy note", () => {
  test("lists everyone who sees the user's images, and how to delete", async ({ page }) => {
    await page.goto("/privacy");
    await expect(page).toHaveTitle("Privacy · GladRags");
    await expect(page.getByRole("heading", { level: 1, name: "Privacy" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "GladRags: how your photos and data are handled" })).toBeVisible();

    const services = page.getByRole("listitem");
    await expect(services).toHaveCount(5);
    for (const lead of ["Your phone.", "Supabase (database, sign-in and image storage, hosted in [region]).", "Google Gemini (paid tier).", "Vercel (hosts the app).", "Shops."]) {
      await expect(services.filter({ hasText: lead })).toHaveCount(1);
    }
    for (const section of ["What we store", "Who sees your images", "Before you take photos", "Deleting", "Questions or a deletion request"]) {
      await expect(page.getByRole("heading", { level: 3, name: section })).toBeVisible();
    }
    await expect(page.getByText(/There are no ads and no analytics/)).toBeVisible();
    await expect(page.getByText(/Location data \(EXIF and GPS\) is removed/)).toBeVisible();
    await expect(page.getByText(/"Delete my account" \(Account, then Delete my account\)/)).toBeVisible();
    await expect(page.getByText(/Contact Cheryl at \[contact address\]/)).toBeVisible();
  });

  test("has no bottom navigation, and Back goes into the app", async ({ page }) => {
    await page.goto("/privacy");
    await expect(page.getByRole("navigation", { name: "Main" })).toHaveCount(0);
    await page.getByRole("link", { name: "Back to GladRags" }).click();
    // Mock mode is always signed in, so "/" lands on the wardrobe.
    await expect(page).toHaveURL(/\/wardrobe$/);
  });

  test("is linked from the sign-in page", async ({ page }) => {
    await page.goto("/sign-in");
    await page.getByRole("link", { name: "How your photos are handled" }).click();
    await expect(page).toHaveURL(/\/privacy$/);
    await expect(page.getByRole("heading", { name: "GladRags: how your photos and data are handled" })).toBeVisible();
  });
});
