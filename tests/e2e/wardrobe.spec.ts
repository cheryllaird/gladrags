import { readFileSync } from "node:fs";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { fakeBackgroundRemoverForFile } from "./helpers";

// Predictable cut-outs: the real model is covered by background-removal.spec.ts.
fakeBackgroundRemoverForFile();

// Journey 1 (build the wardrobe) and the wardrobe screens, on a 390 px phone
// viewport against mock mode. See docs/CONTRACTS.md section 1 for the mock
// markers that trigger the fallback and error states.
//
// The mock store is shared by every test on the server, so these tests only
// delete items they created themselves, and check for specific fixture items
// rather than counts. Each run adds about 10 of the mock user's 40 daily
// items: restart a long-lived local server (reuseExistingServer) after a few
// runs, or the add tests hit daily_cap_reached.

/** A 2400 x 1800 JPEG, bigger than the 1600 px limit, so the client has to resize it. */
const PHOTO = readFileSync(new URL("./fixtures/shirt.jpg", import.meta.url));

function unique(label: string): string {
  return `${label} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

async function choosePhoto(page: Page, name: string, buffer: Buffer = PHOTO, mimeType = "image/jpeg") {
  await page.getByTestId("photo-library-input").setInputFiles({ name, mimeType, buffer });
}

async function expectNoSidewaysScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

function group(page: Page, name: string) {
  return page.getByRole("group", { name, exact: true });
}

/** Width and height from a JPEG's start-of-frame marker, found inside a multipart body. */
function jpegSize(body: Buffer): { width: number; height: number } | null {
  const start = body.indexOf(Buffer.from([0xff, 0xd8, 0xff]));
  if (start < 0) return null;
  for (let i = start + 2; i < body.length - 9; i++) {
    if (body[i] === 0xff && (body[i + 1] === 0xc0 || body[i + 1] === 0xc2)) {
      return { height: body.readUInt16BE(i + 5), width: body.readUInt16BE(i + 7) };
    }
  }
  return null;
}

/** Add an item through the API (not the UI), for tests about an existing item. */
async function createItem(request: APIRequestContext, description: string): Promise<string> {
  const upload = await request.post("/api/items/photo", {
    multipart: { original: { name: "setup.jpg", mimeType: "image/jpeg", buffer: PHOTO } },
  });
  expect(upload.ok()).toBe(true);
  const { draft } = await upload.json();
  const created = await request.post("/api/items", {
    data: {
      source: "photo",
      sourceUrl: null,
      originalImageKey: draft.originalImageKey,
      cutoutImageKey: draft.cutoutImageKey,
      tags: { ...draft.suggestedTags, description },
      tagsEdited: true,
    },
  });
  expect(created.status()).toBe(201);
  return (await created.json()).item.id;
}

test.describe("add by photo", () => {
  test("photo, then review, then save, and it appears in the wardrobe; then straight on to the next", async ({ page }) => {
    let uploadedSize: { width: number; height: number } | null = null;
    await page.route("**/api/items/photo", async (route) => {
      const body = route.request().postDataBuffer();
      if (body) uploadedSize = jpegSize(body);
      await route.continue();
    });

    await page.goto("/add");
    await expect(page.getByRole("heading", { name: "Add an item" })).toBeVisible();
    await expect(page.getByText(/items added today/)).toBeVisible();
    await choosePhoto(page, "IMG_0042.jpg");

    await expect(page.getByRole("heading", { name: "Check the tags" })).toBeVisible();
    // The client resized the 2400 x 1800 photo to 1600 px and re-encoded it as JPEG.
    expect(uploadedSize).toEqual({ width: 1600, height: 1200 });

    // Pre-filled from the (mock) tagger, all editable.
    await expect(group(page, "Category").getByRole("radio", { name: "Top" })).toBeChecked();
    await expect(group(page, "Type").getByRole("radio", { name: "Shirt", exact: true })).toBeChecked();
    await expect(page.getByLabel("Description")).toHaveValue("Navy and white striped linen shirt");
    await expectNoSidewaysScroll(page);

    const description = unique("Photo test shirt");
    await page.getByLabel("Description").fill(description);
    await group(page, "Formality").getByText("3 · Smart casual", { exact: true }).click();
    await page.getByRole("button", { name: "Save to wardrobe" }).click();

    await expect(page.getByText("Saved to your wardrobe")).toBeVisible();
    // "Add another" is offered straight away, camera first.
    await expect(page.getByRole("button", { name: "Take a photo" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Choose from library" })).toBeVisible();

    // The next photo goes straight to processing, with no extra taps.
    await choosePhoto(page, "next-item.jpg");
    await expect(page.getByRole("heading", { name: "Check the tags" })).toBeVisible();
    await page.getByRole("button", { name: "Discard" }).click();
    await expect(page.getByRole("heading", { name: "Add an item" })).toBeVisible();

    await page.getByRole("link", { name: "Wardrobe", exact: true }).click();
    await page.getByRole("searchbox", { name: "Search descriptions" }).fill(description);
    await expect(page.getByRole("link", { name: description })).toBeVisible();
    await page.getByRole("link", { name: description }).click();
    await expect(page.getByRole("heading", { name: description })).toBeVisible();
    await expect(page.getByText("3 · Smart casual")).toBeVisible();
  });

  test("when tagging fails, the tags start empty and must be filled in", async ({ page }) => {
    await page.goto("/add");
    await choosePhoto(page, "jumper-mock-no-tags.jpg");
    await expect(page.getByText("Fill in the tags")).toBeVisible();
    await expect(page.getByLabel("Description")).toHaveValue("");

    await page.getByRole("button", { name: "Save to wardrobe" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "9 things to fix before saving." })).toBeVisible();
    await expect(group(page, "Category").getByText("Choose a category")).toBeVisible();

    await group(page, "Category").getByText("Top", { exact: true }).click();
    await group(page, "Type").getByText("Jumper", { exact: true }).click();
    await group(page, "Colours").getByText("Grey", { exact: true }).click();
    await group(page, "Pattern").getByText("Plain", { exact: true }).click();
    await group(page, "Formality").getByText("2 · Casual", { exact: true }).click();
    await group(page, "Seasons").getByText("Winter", { exact: true }).click();
    await group(page, "Warmth").getByText("Warm", { exact: true }).click();
    await group(page, "Occasions").getByText("Casual", { exact: true }).click();
    const description = unique("Filled-in jumper");
    await page.getByLabel("Description").fill(description);
    await page.getByRole("button", { name: "Save to wardrobe" }).click();
    await expect(page.getByText("Saved to your wardrobe")).toBeVisible();
    await expect(page.getByText(description)).toBeVisible();
  });

  test("a file that isn't a photo gets a clear message", async ({ page }) => {
    await page.goto("/add");
    await choosePhoto(page, "notes.txt", Buffer.from("not an image"), "text/plain");
    await expect(page.getByText("Couldn't use that photo")).toBeVisible();
    await page.getByRole("button", { name: "Try another photo" }).click();
    await expect(page.getByRole("heading", { name: "Add an item" })).toBeVisible();
  });
});

test.describe("add by link", () => {
  test("a readable product page goes through cut-out and tagging to review, and keeps its link", async ({ page }) => {
    const link = `https://shop.example.com/products/linen-shirt-${Date.now()}`;
    await page.goto("/add");
    await page.getByRole("link", { name: "Paste a product link" }).click();
    await page.getByLabel("Product link").fill(link);
    await page.getByRole("button", { name: "Add from link" }).click();

    await expect(page.getByRole("heading", { name: "Check the tags" })).toBeVisible();
    const description = unique("Linked shirt");
    await page.getByLabel("Description").fill(description);
    await page.getByRole("button", { name: "Save to wardrobe" }).click();
    await expect(page.getByText("Saved to your wardrobe")).toBeVisible();
    await expect(page.getByRole("button", { name: "Paste another link" })).toBeVisible();

    await page.getByRole("link", { name: "View item" }).click();
    await expect(page.getByRole("link", { name: "View the product page" })).toHaveAttribute("href", link);
  });

  test("a blocked site asks for a screenshot, which goes down the photo route and keeps the link", async ({ page }) => {
    const link = `https://blocked.example.com/p/${Date.now()}`;
    await page.goto("/add/link");
    await page.getByLabel("Product link").fill(link);
    await page.getByRole("button", { name: "Add from link" }).click();

    await expect(page.getByRole("heading", { name: "Add a screenshot" })).toBeVisible();
    await expect(page.getByText(/^We couldn.t read that page\. Take a screenshot/)).toBeVisible();
    await expectNoSidewaysScroll(page);

    const uploads: string[] = [];
    page.on("request", (r) => {
      if (r.method() === "POST") uploads.push(new URL(r.url()).pathname);
    });
    await choosePhoto(page, "screenshot.png");
    await expect(page.getByRole("heading", { name: "Check the tags" })).toBeVisible();
    expect(uploads).toContain("/api/items/photo");

    const description = unique("Screenshot shirt");
    await page.getByLabel("Description").fill(description);
    await page.getByRole("button", { name: "Save to wardrobe" }).click();
    await expect(page.getByText("Saved to your wardrobe")).toBeVisible();
    await page.getByRole("link", { name: "View item" }).click();
    await expect(page.getByRole("link", { name: "View the product page" })).toHaveAttribute("href", link);
  });

  test("a page with no product data also gets the screenshot fallback", async ({ page }) => {
    await page.goto("/add/link");
    await page.getByLabel("Product link").fill("https://nodata.example.com/p/1");
    await page.getByRole("button", { name: "Add from link" }).click();
    await expect(page.getByRole("button", { name: "Choose a screenshot" })).toBeVisible();
    await page.getByRole("button", { name: "Try a different link" }).click();
    await expect(page.getByLabel("Product link")).toHaveValue("");
  });

  test("a link shared to the installed app is filled in and imports on a tap (PWA share target)", async ({ page }) => {
    const link = `https://shop.example.com/products/shared-${Date.now()}`;
    await page.goto(`/add/link?title=Shirt&text=${encodeURIComponent(`Look at this ${link}`)}`);
    await expect(page.getByLabel("Product link")).toHaveValue(link);
    await page.getByRole("button", { name: "Import this link" }).click();
    await expect(page.getByRole("heading", { name: "Check the tags" })).toBeVisible();
  });

  test("something that isn't a link is caught before sending", async ({ page }) => {
    await page.goto("/add/link");
    await page.getByLabel("Product link").fill("my favourite shirt");
    await page.getByRole("button", { name: "Add from link" }).click();
    await expect(page.getByText("Paste a full link starting with https://")).toBeVisible();
    await expect(page.getByLabel("Product link")).toHaveAttribute("aria-invalid", "true");
  });
});

test.describe("caps and paused AI", () => {
  test("the daily item cap stops a photo with a clear message", async ({ page }) => {
    await page.goto("/add");
    await choosePhoto(page, "shirt-mock-daily-cap.jpg");
    await expect(page.getByText("That's today's limit")).toBeVisible();
    await expect(page.getByText(/You've added 40 items today\. You can add more/)).toBeVisible();
    await expect(page.getByRole("link", { name: "Go to wardrobe" })).toBeVisible();
  });

  test("the daily item cap stops a link too", async ({ page }) => {
    await page.goto("/add/link");
    await page.getByLabel("Product link").fill("https://shop.example.com/p?x=mock-daily-cap");
    await page.getByRole("button", { name: "Add from link" }).click();
    await expect(page.getByText("That's today's limit")).toBeVisible();
  });

  test("paused AI stops adding by photo, and says the wardrobe still works", async ({ page }) => {
    await page.goto("/add");
    await choosePhoto(page, "shirt-mock-ai-paused.jpg");
    await expect(page.getByText("Adding is paused")).toBeVisible();
    await expect(page.getByText(/Your wardrobe still works\. It starts again on 1 /)).toBeVisible();
  });

  test("paused AI stops adding by link", async ({ page }) => {
    await page.goto("/add/link");
    await page.getByLabel("Product link").fill("https://shop.example.com/p?x=mock-ai-paused");
    await page.getByRole("button", { name: "Add from link" }).click();
    await expect(page.getByText("Adding is paused")).toBeVisible();
  });
});

test.describe("wardrobe grid, filters and search", () => {
  test("filters by category, colour and occasion, and searches descriptions", async ({ page }) => {
    await page.goto("/wardrobe");
    await expect(page.getByRole("link", { name: "Camel wool overcoat" })).toBeVisible();
    await expectNoSidewaysScroll(page);

    await page.getByRole("combobox", { name: "Category" }).selectOption({ label: "Shoes" });
    await expect(page.getByRole("link", { name: "White leather trainers" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Camel wool overcoat" })).toHaveCount(0);
    await expect(page).toHaveURL(/category=shoes/);

    await page.getByRole("combobox", { name: "Colour" }).selectOption({ label: "Tan" });
    await expect(page.getByRole("link", { name: /loafers/i })).toBeVisible();
    await expect(page.getByRole("link", { name: "White leather trainers" })).toHaveCount(0);

    // Filters survive a reload because they're in the URL.
    await page.reload();
    await expect(page.getByRole("combobox", { name: "Colour" })).toHaveValue("tan");
    await expect(page.getByRole("link", { name: "White leather trainers" })).toHaveCount(0);

    await page.getByRole("button", { name: "Clear filters" }).click();
    await page.getByRole("combobox", { name: "Occasion" }).selectOption({ label: "Wedding guest" });
    await expect(page.getByRole("link", { name: "Green floral wrap midi dress" })).toBeVisible();
    await expect(page.getByRole("link", { name: "White crew-neck t-shirt" })).toHaveCount(0);

    await page.getByRole("button", { name: "Clear filters" }).click();
    await page.getByRole("searchbox", { name: "Search descriptions" }).fill("merino");
    await expect(page.getByRole("link", { name: "Grey merino crew jumper" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Camel wool overcoat" })).toHaveCount(0);

    await page.getByRole("searchbox", { name: "Search descriptions" }).fill("sequinned cape");
    await expect(page.getByText("Nothing matches those filters.")).toBeVisible();
  });

  test("an item with no cut-out shows its original photo", async ({ page }) => {
    await page.goto("/wardrobe/1a000000-0000-4000-8000-000000000009");
    await expect(page.getByRole("heading", { name: "Camel wool overcoat" })).toBeVisible();
    await expect(page.getByText("this item has no cut-out")).toBeVisible();
    await expect(page.getByRole("img", { name: "Camel wool overcoat" })).toHaveAttribute("src", "/mock/items/camel-coat.svg");
  });

  test("an unknown item says so", async ({ page }) => {
    await page.goto("/wardrobe/1a000000-0000-4000-8000-0000000009ff");
    await expect(page.getByText("That item isn't in your wardrobe.")).toBeVisible();
  });
});

test.describe("item detail", () => {
  test("edit tags", async ({ page, request }) => {
    const description = unique("Edit me shirt");
    const id = await createItem(request, description);
    await page.goto(`/wardrobe/${id}`);
    await expect(page.getByRole("heading", { name: description })).toBeVisible();

    await page.getByRole("button", { name: "Edit tags" }).click();
    await expect(page.getByRole("heading", { name: "Edit tags" })).toBeVisible();
    await group(page, "Pattern").getByText("Check", { exact: true }).click();
    await group(page, "Colours").getByText("Burgundy", { exact: true }).click();
    await page.getByRole("button", { name: "Save tags" }).click();

    await expect(page.getByText("Tags saved.")).toBeVisible();
    await expect(page.getByRole("definition").filter({ hasText: /^Check$/ })).toBeVisible();
    await expect(page.getByText("Navy, White, Burgundy")).toBeVisible();

    await page.reload();
    await expect(page.getByRole("definition").filter({ hasText: /^Check$/ })).toBeVisible();
  });

  test("cancel leaves the tags as they were", async ({ page }) => {
    await page.goto("/wardrobe/1a000000-0000-4000-8000-000000000004");
    await page.getByRole("button", { name: "Edit tags" }).click();
    await group(page, "Pattern").getByText("Floral", { exact: true }).click();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("definition").filter({ hasText: /^Plain$/ })).toBeVisible();
  });

  test("delete, after confirming", async ({ page, request }) => {
    const description = unique("Delete me shirt");
    const id = await createItem(request, description);
    await page.goto(`/wardrobe/${id}`);

    await page.getByRole("button", { name: "Delete" }).click();
    const dialog = page.getByRole("alertdialog", { name: "Delete this item?" });
    await expect(dialog).toContainText("including saved ones");
    await dialog.getByRole("button", { name: "Keep it" }).click();
    await expect(dialog).toHaveCount(0);

    await page.getByRole("button", { name: "Delete" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete item" }).click();
    await expect(page).toHaveURL(/\/wardrobe$/);
    await page.getByRole("searchbox", { name: "Search descriptions" }).fill(description);
    await expect(page.getByText("Nothing matches those filters.")).toBeVisible();
    expect((await request.get(`/api/items/${id}`)).status()).toBe(404);
  });

  test("'Build an outfit around this' opens outfits with the item as the anchor", async ({ page }) => {
    await page.goto("/wardrobe/1a000000-0000-4000-8000-000000000007");
    await expect(page.getByRole("link", { name: "Build an outfit around this" })).toHaveAttribute(
      "href",
      "/outfits?anchor=1a000000-0000-4000-8000-000000000007",
    );
  });
});

test.describe("app shell", () => {
  test("bottom navigation is on the app screens, in thumb reach, and not on sign-in", async ({ page }) => {
    await page.goto("/wardrobe");
    const nav = page.getByRole("navigation", { name: "Main" });
    await expect(nav.getByRole("link", { name: "Wardrobe" })).toHaveAttribute("aria-current", "page");
    await expect(nav.getByRole("link", { name: "Add" })).toHaveAttribute("href", "/add");
    await expect(nav.getByRole("link", { name: "Outfits" })).toHaveAttribute("href", "/outfits");
    await expect(nav.getByRole("link", { name: "Saved" })).toHaveAttribute("href", "/outfits/saved");

    // outfit-ui pads its pages and places its sticky bars with this variable.
    const navHeight = await page.evaluate(() => {
      const bar = document.querySelector('nav[aria-label="Main"] ul')!;
      return { variable: getComputedStyle(bar).getPropertyValue("--bottom-nav-height").trim(), px: bar.getBoundingClientRect().height };
    });
    expect(navHeight).toEqual({ variable: "4rem", px: 64 });

    const box = await nav.boundingBox();
    expect(box!.y + box!.height).toBeGreaterThanOrEqual(844 - 1);
    for (const link of await nav.getByRole("link").all()) {
      const size = await link.boundingBox();
      expect(size!.height).toBeGreaterThanOrEqual(44);
      expect(size!.width).toBeGreaterThanOrEqual(44);
    }

    await nav.getByRole("link", { name: "Add" }).click();
    await expect(nav.getByRole("link", { name: "Add" })).toHaveAttribute("aria-current", "page");

    await page.goto("/sign-in");
    await expect(page.getByRole("navigation", { name: "Main" })).toHaveCount(0);
  });
});
