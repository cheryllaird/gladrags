import { readFileSync } from "node:fs";
import { test, type Page } from "@playwright/test";

// 390 px screenshots of the wardrobe screens for Cheryl's preview, saved to
// docs/screens/wardrobe/. Skipped in normal runs. To refresh them:
//
//   pnpm build && SCREENSHOTS=1 PLAYWRIGHT_USE_BUILD=true pnpm test:e2e screens
//
// (The production build has no Next.js dev overlay in the pictures.)

test.skip(process.env.SCREENSHOTS !== "1", "Set SCREENSHOTS=1 to refresh docs/screens/wardrobe/");
test.describe.configure({ mode: "serial" });

const OUT = "docs/screens/wardrobe";
const PHOTO = readFileSync(new URL("./fixtures/shirt.jpg", import.meta.url));

async function shot(page: Page, name: string, fullPage = false) {
  await page.waitForFunction(() => [...document.images].every((img) => img.complete));
  // Let images and fonts settle so the pictures are stable.
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/${name}.png`, scale: "css", fullPage, animations: "disabled" });
}

async function choosePhoto(page: Page, name: string) {
  await page.getByTestId("photo-library-input").setInputFiles({ name, mimeType: "image/jpeg", buffer: PHOTO });
}

test("sign-in", async ({ page }) => {
  await page.goto("/sign-in");
  await shot(page, "01-sign-in");
  await page.getByLabel("Email").fill("cheryl@example.com");
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await page.getByLabel("Code from the email").waitFor();
  await shot(page, "02-sign-in-code");
});

test("wardrobe", async ({ page }) => {
  await page.goto("/wardrobe");
  await page.getByRole("link", { name: "Camel wool overcoat" }).waitFor();
  await shot(page, "03-wardrobe");
  await page.goto("/wardrobe?category=shoes");
  await page.getByRole("link", { name: "White leather trainers" }).waitFor();
  await shot(page, "04-wardrobe-filtered");
  await page.goto("/wardrobe?q=sequinned");
  await page.getByText("Nothing matches those filters.").waitFor();
  await shot(page, "05-wardrobe-no-matches");
});

test("item detail", async ({ page }) => {
  await page.goto("/wardrobe/1a000000-0000-4000-8000-000000000007");
  await page.getByRole("heading", { name: "Green floral wrap midi dress" }).waitFor();
  await shot(page, "06-item-detail");
  await page.goto("/wardrobe/1a000000-0000-4000-8000-000000000009");
  await page.getByText("this item has no cut-out").waitFor();
  await shot(page, "07-item-detail-no-cutout");
  await page.getByRole("button", { name: "Edit tags" }).click();
  await shot(page, "08-item-edit-tags");
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Delete" }).click();
  await page.getByRole("alertdialog").waitFor();
  await shot(page, "09-item-delete-confirm");
});

test("add by photo", async ({ page }) => {
  await page.goto("/add");
  await page.getByText(/items added today/).waitFor();
  await shot(page, "10-add");

  // Hold the upload so the progress state can be captured.
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/items/photo", async (route) => {
    await held;
    await route.continue();
  });
  await choosePhoto(page, "shirt.jpg");
  await page.getByText("Uploading and tagging…").waitFor();
  await page.screenshot({ path: `${OUT}/11-add-progress.png`, scale: "css", animations: "disabled" });
  release();

  await page.getByRole("heading", { name: "Check the tags" }).waitFor();
  await shot(page, "12-review");
  await shot(page, "13-review-full", true);
  await page.getByRole("button", { name: "Save to wardrobe" }).click();
  await page.getByText("Saved to your wardrobe").waitFor();
  await shot(page, "14-saved-add-another");
});

test("add by photo with empty tags", async ({ page }) => {
  await page.goto("/add");
  await choosePhoto(page, "shirt-mock-no-tags.jpg");
  await page.getByText("Fill in the tags").waitFor();
  await page.getByRole("button", { name: "Save to wardrobe" }).click();
  await page.getByText("9 things to fix before saving.").waitFor();
  await page.evaluate(() => window.scrollTo({ top: 0 }));
  await shot(page, "15-review-empty-tags");
});

test("add by link", async ({ page }) => {
  await page.goto("/add/link");
  await page.getByLabel("Product link").fill("https://shop.example.com/products/linen-shirt");
  await shot(page, "16-add-link");
  await page.getByLabel("Product link").fill("https://blocked.example.com/products/linen-shirt");
  await page.getByRole("button", { name: "Add from link" }).click();
  await page.getByRole("heading", { name: "Add a screenshot" }).waitFor();
  await shot(page, "17-add-link-screenshot-fallback");
});

test("account sheet", async ({ page }) => {
  await page.goto("/wardrobe");
  await page.getByRole("button", { name: "Account" }).click();
  await page.getByRole("dialog", { name: "Account" }).waitFor();
  await shot(page, "20-account-sheet");
  await page.getByRole("button", { name: "Delete my account" }).click();
  await page.getByRole("alertdialog").waitFor();
  await shot(page, "21-account-delete-confirm");
});

test("signed out mid-add", async ({ page }) => {
  await page.route(
    (url) => url.pathname === "/api/items",
    (route) =>
      route.request().method() === "POST"
        ? route.fulfill({ status: 401, json: { error: { code: "unauthorized", message: "Sign in to continue." } } })
        : route.continue(),
  );
  await page.goto("/add");
  await choosePhoto(page, "shirt.jpg");
  await page.getByRole("button", { name: "Save to wardrobe" }).click();
  await page.getByRole("heading", { name: "Sign in to GladRags" }).waitFor();
  await shot(page, "22-sign-in-after-expiry");
  await page.unrouteAll();
  await page.getByLabel("Email").fill("cheryl@example.com");
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await page.getByLabel("Code from the email").fill("123456");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByText("We kept the item you were adding.").waitFor();
  await shot(page, "23-add-restored-after-sign-in");
});

test("caps and paused AI", async ({ page }) => {
  await page.goto("/add");
  await choosePhoto(page, "shirt-mock-daily-cap.jpg");
  await page.getByText("That's today's limit").waitFor();
  await shot(page, "18-daily-cap");
  await page.goto("/add");
  await choosePhoto(page, "shirt-mock-ai-paused.jpg");
  await page.getByText("Adding is paused").waitFor();
  await shot(page, "19-ai-paused");
});
