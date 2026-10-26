import { readFileSync } from "node:fs";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { fakeBackgroundRemoverForFile } from "./helpers";

// Predictable cut-outs: the real model is covered by background-removal.spec.ts.
fakeBackgroundRemoverForFile();

// Recovery paths on the wardrobe screens, at 390 px against mock mode:
// expiring signed image URLs, an expired session (sign in again without
// losing the item being added), the Account sheet, link-flow retries, and
// item detail retries. Most tests answer API routes themselves (page.route)
// so they don't touch the shared mock store or the daily item cap.

const PHOTO = readFileSync(new URL("./fixtures/shirt.jpg", import.meta.url));

function apiError(code: string, message: string) {
  return { error: { code, message } };
}

function unique(label: string): string {
  return `${label} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

async function choosePhoto(page: Page, name: string) {
  await page.getByTestId("photo-library-input").setInputFiles({ name, mimeType: "image/jpeg", buffer: PHOTO });
}

/** Mock-mode sign-in: any email on the allowlist, any 6-digit code. */
async function signInAgain(page: Page) {
  await expect(page.getByRole("heading", { name: "Sign in to GladRags" })).toBeVisible();
  await expect(page.getByText("You've been signed out.")).toBeVisible();
  await page.getByLabel("Email").fill("cheryl@example.com");
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await page.getByLabel("Code from the email").fill("123456");
  await page.getByRole("button", { name: "Sign in" }).click();
}

function countItemsRequests(page: Page): () => number {
  let count = 0;
  page.on("request", (r) => {
    if (new URL(r.url()).pathname === "/api/items" && r.method() === "GET") count++;
  });
  return () => count;
}

async function createItem(request: APIRequestContext, description: string): Promise<string> {
  const upload = await request.post("/api/items/photo", {
    multipart: { original: { name: "setup.jpg", mimeType: "image/jpeg", buffer: PHOTO } },
  });
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
  return (await created.json()).item.id;
}

test.describe("expiring signed image URLs", () => {
  // Counts are taken relative to "after the 403" or "after loading": the dev
  // server's React strict mode runs mount effects twice, so the first load
  // can make two requests.

  test("an image that fails (403) makes the wardrobe fetch fresh URLs once, and the image then loads", async ({ page }) => {
    const itemsRequests = countItemsRequests(page);
    let refused = 0;
    let requestsAtRefusal = 0;
    await page.route("**/mock/items/white-tshirt.svg", (route) => {
      if (refused++ === 0) {
        requestsAtRefusal = itemsRequests();
        return route.fulfill({ status: 403, body: "Expired" });
      }
      return route.continue();
    });
    await page.goto("/wardrobe");
    const tshirt = page.getByRole("link", { name: "White crew-neck t-shirt" }).locator("img");
    await expect.poll(() => itemsRequests() - requestsAtRefusal).toBe(1);
    await expect.poll(() => tshirt.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
    // Only once, however many images fail.
    await page.waitForTimeout(500);
    expect(itemsRequests() - requestsAtRefusal).toBe(1);
  });

  test("item detail fetches the item again when its image fails", async ({ page }) => {
    let itemRequests = 0;
    page.on("request", (r) => {
      if (new URL(r.url()).pathname === "/api/items/1a000000-0000-4000-8000-000000000007") itemRequests++;
    });
    let refused = 0;
    let requestsAtRefusal = 0;
    await page.route("**/mock/items/green-floral-dress.svg", (route) => {
      if (refused++ === 0) {
        requestsAtRefusal = itemRequests;
        return route.fulfill({ status: 403, body: "Expired" });
      }
      return route.continue();
    });
    await page.goto("/wardrobe/1a000000-0000-4000-8000-000000000007");
    await expect.poll(() => itemRequests - requestsAtRefusal).toBe(1);
    const image = page.getByRole("img", { name: "Green floral wrap midi dress" });
    await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  });

  test("coming back to the app after 50 minutes refetches; sooner doesn't", async ({ page }) => {
    await page.clock.install();
    const itemsRequests = countItemsRequests(page);
    await page.goto("/wardrobe");
    await expect(page.getByRole("link", { name: "Camel wool overcoat" })).toBeVisible();
    await page.waitForTimeout(300);
    const loaded = itemsRequests();

    await page.clock.fastForward("10:00");
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await page.waitForTimeout(300);
    expect(itemsRequests()).toBe(loaded);

    await page.clock.fastForward("41:00");
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect.poll(itemsRequests).toBe(loaded + 1);
  });
});

test.describe("an expired session", () => {
  test("goes to sign-in and back to the same filtered wardrobe", async ({ page }) => {
    let refused = false;
    await page.route(
      (url) => url.pathname === "/api/items",
      (route) => {
        if (refused) return route.continue();
        refused = true;
        return route.fulfill({ status: 401, json: apiError("unauthorized", "Sign in to continue.") });
      },
    );
    await page.goto("/wardrobe?category=shoes");
    await expect(page).toHaveURL(/\/sign-in\?next=%2Fwardrobe%3Fcategory%3Dshoes&reason=expired/);
    await signInAgain(page);
    await expect(page).toHaveURL(/\/wardrobe\?category=shoes$/);
    await expect(page.getByRole("link", { name: "White leather trainers" })).toBeVisible();
  });

  test("while saving keeps the item and the tags the user chose, ready to save after sign-in", async ({ page }) => {
    let refused = false;
    await page.route(
      (url) => url.pathname === "/api/items",
      (route) => {
        if (route.request().method() !== "POST" || refused) return route.continue();
        refused = true;
        return route.fulfill({ status: 401, json: apiError("unauthorized", "Sign in to continue.") });
      },
    );
    await page.goto("/add");
    await choosePhoto(page, "kept.jpg");
    const description = unique("Kept through sign-in");
    await page.getByLabel("Description").fill(description);
    await page.getByRole("button", { name: "Save to wardrobe" }).click();

    await signInAgain(page);
    await expect(page).toHaveURL(/\/add$/);
    await expect(page.getByText("We kept the item you were adding.")).toBeVisible();
    await expect(page.getByLabel("Description")).toHaveValue(description);
    await page.getByRole("button", { name: "Save to wardrobe" }).click();
    await expect(page.getByText("Saved to your wardrobe")).toBeVisible();
    await expect(page.getByText(description)).toBeVisible();
  });

  test("while uploading says the photo needs choosing again", async ({ page }) => {
    await page.route("**/api/items/photo", (route) =>
      route.fulfill({ status: 401, json: apiError("unauthorized", "Sign in to continue.") }),
    );
    await page.goto("/add");
    await choosePhoto(page, "lost.jpg");
    await signInAgain(page);
    await expect(page).toHaveURL(/\/add$/);
    await expect(page.getByText("Choose it again to carry on.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Choose from library" })).toBeVisible();
  });

  test("a wrong sign-in code stays on sign-in with its message", async ({ page }) => {
    await page.route("**/api/auth/verify-code", (route) =>
      route.fulfill({ status: 401, json: apiError("unauthorized", "That code didn't work. Check it and try again.") }),
    );
    await page.goto("/sign-in");
    await page.getByLabel("Email").fill("cheryl@example.com");
    await page.getByRole("button", { name: "Email me a sign-in link" }).click();
    await page.getByLabel("Code from the email").fill("000000");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "That code didn't work" })).toBeVisible();
    await expect(page).toHaveURL(/\/sign-in$/);
  });
});

test.describe("Account sheet", () => {
  test("shows the email and Sign out, and deletes the account after a clear warning", async ({ page }) => {
    let deleted = 0;
    // Answered here: in mock mode the real route resets the store every other test uses.
    await page.route("**/api/account", (route) => {
      deleted++;
      return route.fulfill({ status: 200, json: { deleted: true } });
    });
    await page.goto("/wardrobe");
    await page.getByRole("button", { name: "Account" }).click();
    const sheet = page.getByRole("dialog", { name: "Account" });
    await expect(sheet.getByText("Signed in as mock.user@gladrags.test")).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Sign out" })).toBeVisible();

    await sheet.getByRole("button", { name: "Delete my account" }).click();
    const confirm = page.getByRole("alertdialog", { name: "Delete your account?" });
    await expect(confirm).toContainText("photos");
    await expect(confirm).toContainText("can't undo this");
    await confirm.getByRole("button", { name: "Keep my account" }).click();
    expect(deleted).toBe(0);

    await sheet.getByRole("button", { name: "Delete my account" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete everything" }).click();
    await expect(page).toHaveURL(/\/sign-in$/);
    expect(deleted).toBe(1);
  });
});

test.describe("link flow retries", () => {
  test("Try again keeps the pasted link", async ({ page }) => {
    let failed = false;
    await page.route("**/api/items/link", (route) => {
      if (failed) return route.continue();
      failed = true;
      return route.fulfill({ status: 500, json: apiError("internal", "Something went wrong on our side") });
    });
    const link = "https://shop.example.com/products/retry-me";
    await page.goto("/add/link");
    await page.getByLabel("Product link").fill(link);
    await page.getByRole("button", { name: "Add from link" }).click();
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByLabel("Product link")).toHaveValue(link);
  });

  test("a failed screenshot goes back to the screenshot step for the same link", async ({ page }) => {
    let failed = false;
    await page.route("**/api/items/photo", (route) => {
      if (failed) {
        return route.fulfill({
          status: 200,
          json: {
            draft: {
              source: "link",
              sourceUrl: route.request().postDataBuffer()?.toString("latin1").match(/https:\/\/blocked\.example\.com\/p\/\w+/)?.[0] ?? null,
              originalImageKey: "0a000000-0000-4000-8000-000000000001/1b000000-0000-4000-8000-0000000000b1.jpg",
              cutoutImageKey: null,
              originalUrl: "/mock/items/uploaded.svg",
              cutoutUrl: null,
              suggestedTags: null,
            },
          },
        });
      }
      failed = true;
      return route.fulfill({ status: 500, json: apiError("internal", "Something went wrong on our side") });
    });
    await page.goto("/add/link");
    await page.getByLabel("Product link").fill("https://blocked.example.com/p/again");
    await page.getByRole("button", { name: "Add from link" }).click();
    await choosePhoto(page, "screenshot.png");
    await page.getByRole("button", { name: "Try another screenshot" }).click();
    await expect(page.getByRole("heading", { name: "Add a screenshot" })).toBeVisible();

    const sent: string[] = [];
    page.on("request", (r) => {
      if (new URL(r.url()).pathname === "/api/items/photo") sent.push(r.postDataBuffer()?.toString("latin1") ?? "");
    });
    await choosePhoto(page, "screenshot-2.png");
    await expect(page.getByRole("heading", { name: "Check the tags" })).toBeVisible();
    expect(sent[0]).toContain("https://blocked.example.com/p/again");
  });

  test("the screenshot buttons are disabled while adding is paused", async ({ page }) => {
    // Paused from the moment the link is sent (the screen re-reads usage after it).
    let linkSent = false;
    page.on("request", (r) => {
      if (new URL(r.url()).pathname === "/api/items/link") linkSent = true;
    });
    await page.route("**/api/usage", (route) => {
      return route.fulfill({
        status: 200,
        json: {
          itemsToday: { used: 3, limit: 40 },
          outfitRequestsToday: { used: 0, limit: 25 },
          dailyResetAt: "2030-01-01T00:00:00.000Z",
          aiPaused: linkSent,
        },
      });
    });
    await page.goto("/add/link");
    await page.getByLabel("Product link").fill("https://blocked.example.com/p/paused");
    await page.getByRole("button", { name: "Add from link" }).click();
    await expect(page.getByRole("button", { name: "Choose a screenshot" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Take a photo instead" })).toBeDisabled();
  });

  test("after saving a shared link, the address no longer carries it, so reload doesn't import it again", async ({ page }) => {
    await page.goto(`/add/link?url=${encodeURIComponent(`https://shop.example.com/products/shared-${Date.now()}`)}`);
    await expect(page.getByRole("heading", { name: "Check the tags" })).toBeVisible();
    await page.getByLabel("Description").fill(unique("Shared then saved"));
    await page.getByRole("button", { name: "Save to wardrobe" }).click();
    await expect(page.getByText("Saved to your wardrobe")).toBeVisible();
    await expect(page).toHaveURL(/\/add\/link$/);

    let imports = 0;
    page.on("request", (r) => {
      if (new URL(r.url()).pathname === "/api/items/link") imports++;
    });
    await page.reload();
    await expect(page.getByLabel("Product link")).toHaveValue("");
    expect(imports).toBe(0);
  });
});

test.describe("item detail recovery", () => {
  test("a failed load offers Try again", async ({ page }) => {
    let failing = true;
    await page.route("**/api/items/1a000000-0000-4000-8000-000000000004", (route) =>
      failing ? route.fulfill({ status: 500, json: apiError("internal", "Something went wrong on our side") }) : route.continue(),
    );
    await page.goto("/wardrobe/1a000000-0000-4000-8000-000000000004");
    await expect(page.getByText("Something went wrong on our side")).toBeVisible();
    failing = false;
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByRole("heading", { name: "Mid-blue straight-leg jeans" })).toBeVisible();
  });

  test("deleting returns to the wardrobe with the filters the user came from", async ({ page, request }) => {
    const description = unique("Filtered delete");
    const id = await createItem(request, description);
    await page.goto("/wardrobe");
    await page.getByRole("searchbox", { name: "Search descriptions" }).fill(description);
    await page.getByRole("combobox", { name: "Category" }).selectOption("top");
    await page.getByRole("link", { name: description }).click();
    await expect(page).toHaveURL(new RegExp(`/wardrobe/${id}$`));

    await page.getByRole("button", { name: "Delete" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete item" }).click();
    await expect(page).toHaveURL(/\/wardrobe\?category=top&q=/);
    await expect(page.getByRole("combobox", { name: "Category" })).toHaveValue("top");
    await expect(page.getByText("Nothing matches those filters.")).toBeVisible();
  });
});
