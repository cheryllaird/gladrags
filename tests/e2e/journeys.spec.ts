import { readFileSync } from "node:fs";
import { expect, test, type Locator, type Page, type Response } from "@playwright/test";
import {
  ItemResponseSchema,
  OutfitGenerationResponseSchema,
  OutfitListResponseSchema,
  OutfitResponseSchema,
  missingCategoriesForOutfits,
  type Category,
  type Outfit,
} from "@/contracts";
import { fakeBackgroundRemoverForFile } from "./helpers";

// The spec's five core journeys (docs/SPEC.md, "Users and core journeys"),
// end to end across the integrated app: each starts at the front door and
// moves through the real navigation, on a 390 px phone against mock mode.
// The milestone 5 versions (get-started checklist, batch adds, order
// emails, gaps, shop search, collage-time cut-outs) are in
// journeys-m5.spec.ts; this file keeps the single-item journeys, the
// missing-category notice and account deletion.
//
// No route is intercepted except where noted, to force a state the shared
// mock store can't reach safely (missing category, account deletion).
//
// The mock store is shared with every other spec on the server, so tests
// here only ever ADD data, never delete it (as in foundations.spec.ts):
// deleting an item also deletes every outfit that uses it, which can give a
// parallel outfit test a 404. Unique descriptions and IDs keep the tests
// independent, and none assumes a list's length. The one state change undone
// afterwards is journey 5's outfit statuses, so avoid hints don't build up.

// Predictable cut-outs; the real model has its own spec (background-removal.spec.ts).
fakeBackgroundRemoverForFile();

const PHOTO = readFileSync(new URL("./fixtures/shirt.jpg", import.meta.url));
const NAVY_BLAZER = { id: "1a000000-0000-4000-8000-000000000008", description: "Navy single-breasted blazer" };

function unique(label: string): string {
  return `${label} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

const nav = (page: Page) => page.getByRole("navigation", { name: "Main" });
const group = (page: Page, name: string) => page.getByRole("group", { name, exact: true });
const outfitCards = (page: Page) => page.getByTestId("outfit-card");

/** The front door: "/" lands on the wardrobe, with the bottom nav. */
async function openApp(page: Page) {
  await page.goto("/");
  await expect(page).toHaveURL(/\/wardrobe$/);
  await expect(nav(page)).toBeVisible();
}

async function tapRadio(page: Page, name: string) {
  const radio = page.getByRole("radio", { name, exact: true });
  await radio.locator("xpath=ancestor::label[1]").click();
  await expect(radio).toBeChecked();
}

function outfitsResponse(page: Page, path: RegExp): Promise<Response> {
  return page.waitForResponse((res) => res.request().method() === "POST" && path.test(new URL(res.url()).pathname));
}

/** Parse an outfit-generation response with the shared contract and return its outfits. */
async function outfitsFrom(response: Response): Promise<Outfit[]> {
  expect(response.status()).toBe(200);
  const parsed = OutfitGenerationResponseSchema.parse(await response.json());
  if (parsed.status !== "ok") throw new Error(`expected outfits, got ${parsed.status}: ${parsed.message}`);
  return parsed.outfits;
}

async function cardIds(page: Page): Promise<string[]> {
  return outfitCards(page).evaluateAll((els) => els.map((el) => el.getAttribute("data-outfit-id")!));
}

/** Every collage is drawn: the canvas is ready and has opaque pixels on it. */
async function expectCollagesDrawn(cards: Locator) {
  const count = await cards.count();
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < count; i++) {
    const canvas = cards.nth(i).getByTestId("outfit-collage");
    await canvas.scrollIntoViewIfNeeded();
    await expect(canvas).toHaveAttribute("data-state", "ready");
    const painted = await canvas.evaluate((el: HTMLCanvasElement) => {
      const data = el.getContext("2d")!.getImageData(0, 0, el.width, el.height).data;
      let opaque = 0;
      for (let p = 3; p < data.length; p += 4) if (data[p]! > 0) opaque++;
      return { opaque, total: el.width * el.height };
    });
    expect(painted.total).toBeGreaterThan(0);
    // At least a few percent of the canvas is painted: real cut-outs, not a blank frame.
    expect(painted.opaque / painted.total).toBeGreaterThan(0.02);
  }
}

async function expectNoSidewaysScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

async function findInWardrobe(page: Page, description: string) {
  await nav(page).getByRole("link", { name: "Wardrobe" }).click();
  await expect(page).toHaveURL(/\/wardrobe/);
  await page.getByRole("searchbox", { name: "Search descriptions" }).fill(description);
  await expect(page.getByRole("link", { name: description })).toBeVisible();
}

test.describe("journey 1: build the wardrobe", () => {
  test("sign in, add an item by photo, edit a tag, save, and it's in the wardrobe grid", async ({ page }) => {
    // Sign in (mock mode accepts any 6-digit code).
    await page.goto("/sign-in");
    await expect(page.getByRole("heading", { name: "Sign in to GladRags" })).toBeVisible();
    await expect(nav(page)).toHaveCount(0);
    await page.getByLabel("Email").fill("tester@example.com");
    await page.getByRole("button", { name: "Email me a sign-in link" }).click();
    await expect(page.getByText("tester@example.com")).toBeVisible();
    await page.getByLabel("Code from the email").fill("123456");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/wardrobe$/);

    // Add by photo, from the nav.
    await nav(page).getByRole("link", { name: "Add" }).click();
    await expect(page.getByRole("heading", { name: "Add an item" })).toBeVisible();
    const upload = page.waitForResponse((res) => new URL(res.url()).pathname === "/api/items/photo");
    await page.getByTestId("photo-library-input").setInputFiles({ name: "IMG_1001.jpg", mimeType: "image/jpeg", buffer: PHOTO });
    expect((await upload).status()).toBe(200);

    // Review the auto-filled tags and correct two of them.
    await expect(page.getByRole("heading", { name: "Check the tags" })).toBeVisible();
    await expect(group(page, "Category").getByRole("radio", { name: "Top" })).toBeChecked();
    await expect(page.getByLabel("Description")).not.toHaveValue("");
    await expectNoSidewaysScroll(page);
    const description = unique("Journey one shirt");
    await page.getByLabel("Description").fill(description);
    await group(page, "Formality").getByText("3 · Smart casual", { exact: true }).click();

    const saved = page.waitForResponse((res) => res.request().method() === "POST" && new URL(res.url()).pathname === "/api/items");
    await page.getByRole("button", { name: "Save to wardrobe" }).click();
    const savedRes = await saved;
    expect(savedRes.status()).toBe(201);
    const { item } = ItemResponseSchema.parse(await savedRes.json());
    expect(item).toMatchObject({ source: "photo", sourceUrl: null, tagsEdited: true });
    // Milestone 5: no cut-out while adding; a collage makes one the first time it needs it.
    expect(item.cutoutUrl).toBeNull();
    await expect(page.getByText("Saved to your wardrobe")).toBeVisible();

    // It's in the wardrobe grid, and its detail shows the edited tag.
    await findInWardrobe(page, description);
    await page.getByRole("link", { name: description }).click();
    await expect(page.getByRole("heading", { name: description })).toBeVisible();
    await expect(page.getByText("3 · Smart casual")).toBeVisible();
  });
});

test.describe("journey 2: outfits for an occasion", () => {
  test("from the nav, a preset plus guidance gives 3 to 5 drawn collages", async ({ page }) => {
    await openApp(page);
    await nav(page).getByRole("link", { name: "Outfits" }).click();
    await expect(page.getByRole("heading", { name: "Outfit ideas" })).toBeVisible();

    await tapRadio(page, "Work");
    await page.getByLabel("Anything else? (optional)").fill("no heels");
    const response = outfitsResponse(page, /^\/api\/outfits$/);
    await page.getByRole("button", { name: "Get outfits" }).click();
    const outfits = await outfitsFrom(await response);
    expect((await response).request().postDataJSON()).toEqual({
      style: { kind: "preset", presetId: "work" },
      guidance: "no heels",
      count: 4,
    });

    await expect(page.getByRole("heading", { name: "Outfits for Work" })).toBeVisible();
    const cards = outfitCards(page);
    expect(outfits.length).toBeGreaterThanOrEqual(3);
    expect(outfits.length).toBeLessThanOrEqual(5);
    await expect(cards).toHaveCount(outfits.length);
    const count = outfits.length;
    expect(await cardIds(page)).toEqual(outfits.map((o) => o.id));
    for (let i = 0; i < count; i++) {
      await expect(cards.nth(i).getByRole("heading", { level: 2 })).not.toBeEmpty();
    }
    // The guidance travels with every outfit (to the model, and to later refinements).
    // Honouring "no heels" is the ranking model's job, not a code filter, so the
    // mock ranker isn't held to it here.
    for (const outfit of outfits) {
      expect(outfit.request.guidance).toBe("no heels");
      expect(outfit.request.style).toEqual({ kind: "preset", presetId: "work" });
    }
    await expectCollagesDrawn(cards);
    await expectNoSidewaysScroll(page);
  });

  test("or a style typed in their own words gives drawn collages for it", async ({ page }) => {
    await openApp(page);
    await nav(page).getByRole("link", { name: "Outfits" }).click();
    await tapRadio(page, "Something else");
    await page.getByLabel("Describe the occasion").fill("picnic in the park");
    const response = outfitsResponse(page, /^\/api\/outfits$/);
    await page.getByRole("button", { name: "Get outfits" }).click();
    const outfits = await outfitsFrom(await response);
    const sent = (await response).request().postDataJSON();
    expect(sent.style.kind).toBe("custom");
    expect(sent).toEqual({ style: { kind: "custom", text: "picnic in the park" }, count: 4 });

    await expect(page.getByRole("heading", { name: "Outfits for “picnic in the park”" })).toBeVisible();
    expect(outfits.length).toBeGreaterThanOrEqual(3);
    expect(outfits.length).toBeLessThanOrEqual(5);
    for (const outfit of outfits) expect(outfit.request.style).toEqual({ kind: "custom", text: "picnic in the park" });
    const cards = outfitCards(page);
    await expect(cards).toHaveCount(outfits.length);
    expect(await cardIds(page)).toEqual(outfits.map((o) => o.id));
    await expectCollagesDrawn(cards);
  });
});

test.describe("journey 3: build around an item", () => {
  test("wardrobe, item detail, 'Build an outfit around this': every outfit includes the item", async ({ page }) => {
    await openApp(page);
    await page.getByRole("searchbox", { name: "Search descriptions" }).fill("blazer");
    await page.getByRole("link", { name: NAVY_BLAZER.description }).click();
    await expect(page.getByRole("heading", { name: NAVY_BLAZER.description })).toBeVisible();

    await page.getByRole("link", { name: "Build an outfit around this" }).click();
    await expect(page).toHaveURL(new RegExp(`/outfits\\?anchor=${NAVY_BLAZER.id}$`));
    await expect(nav(page).getByRole("link", { name: "Outfits" })).toHaveAttribute("aria-current", "page");
    await expect(page.getByTestId("anchor-item")).toContainText(NAVY_BLAZER.description);

    await tapRadio(page, "Smart casual");
    const response = outfitsResponse(page, /^\/api\/outfits$/);
    await page.getByRole("button", { name: "Get outfits" }).click();
    const outfits = await outfitsFrom(await response);
    expect((await response).request().postDataJSON()).toMatchObject({ anchorItemId: NAVY_BLAZER.id });

    expect(outfits.length).toBeGreaterThanOrEqual(3);
    for (const outfit of outfits) {
      expect(outfit.itemIds).toContain(NAVY_BLAZER.id);
      expect(outfit.request.anchorItemId).toBe(NAVY_BLAZER.id);
    }
    const cards = outfitCards(page);
    await expect(cards).toHaveCount(outfits.length);
    for (let i = 0; i < outfits.length; i++) {
      const row = cards
        .nth(i)
        .getByRole("list", { name: "Items in this outfit" })
        .getByRole("listitem")
        .filter({ hasText: NAVY_BLAZER.description });
      await expect(row).toContainText("Your pick");
    }
    await expectCollagesDrawn(cards);
  });
});

test.describe("journey 4: refine", () => {
  test("swap one item, then apply guidance: each revised set points back to its parent", async ({ page }) => {
    await openApp(page);
    await nav(page).getByRole("link", { name: "Outfits" }).click();
    await tapRadio(page, "Casual");
    let response = outfitsResponse(page, /^\/api\/outfits$/);
    await page.getByRole("button", { name: "Get outfits" }).click();
    const first = await outfitsFrom(await response);
    const cards = outfitCards(page);
    await expect(cards).toHaveCount(first.length);

    // Swap the shoes on the first outfit.
    const parent = first[0]!;
    const shoes = parent.items.find((i) => i.tags.category === "shoes")!;
    response = outfitsResponse(page, /^\/api\/outfits\/[^/]+\/refine$/);
    await cards.first().getByRole("button", { name: `Swap ${shoes.tags.description}` }).click();
    const swapped = await outfitsFrom(await response);
    expect(new URL((await response).url()).pathname).toBe(`/api/outfits/${parent.id}/refine`);
    expect((await response).request().postDataJSON()).toEqual({ kind: "swap", itemId: shoes.id });

    await expect(page.getByRole("heading", { name: `Swapped out the ${shoes.tags.description.toLowerCase()}` })).toBeVisible();
    expect(swapped.length).toBeGreaterThan(0);
    for (const outfit of swapped) {
      expect(outfit.parentOutfitId).toBe(parent.id);
      expect(outfit.itemIds).not.toContain(shoes.id);
      expect(first.map((o) => o.id)).not.toContain(outfit.id);
    }
    await expect(cards).toHaveCount(swapped.length);
    expect(await cardIds(page)).toEqual(swapped.map((o) => o.id));
    await expectCollagesDrawn(cards);

    // Then guidance on the first revised outfit.
    const second = swapped[0]!;
    response = outfitsResponse(page, /^\/api\/outfits\/[^/]+\/refine$/);
    await cards.first().getByRole("button", { name: "Tweak this outfit" }).click();
    await cards.first().getByPlaceholder("Or say what to change").fill("warmer");
    await cards.first().getByRole("button", { name: "Update" }).click();
    const tweaked = await outfitsFrom(await response);
    expect(new URL((await response).url()).pathname).toBe(`/api/outfits/${second.id}/refine`);
    await expect(page.getByRole("heading", { name: "Tweaked: warmer" })).toBeVisible();
    expect(tweaked.length).toBeGreaterThan(0);
    for (const outfit of tweaked) expect(outfit.parentOutfitId).toBe(second.id);
    await expect(cards).toHaveCount(tweaked.length);
    expect(await cardIds(page)).toEqual(tweaked.map((o) => o.id));
    await expectCollagesDrawn(cards);
  });
});

test.describe("journey 5: save and rate", () => {
  test("save one, like one, reject one with a reason; saved and liked show on the Saved screen", async ({ page, request }) => {
    await openApp(page);
    await nav(page).getByRole("link", { name: "Outfits" }).click();
    await tapRadio(page, "Evening out");
    const response = outfitsResponse(page, /^\/api\/outfits$/);
    await page.getByRole("button", { name: "Get outfits" }).click();
    const outfits = await outfitsFrom(await response);
    expect(outfits.length).toBeGreaterThanOrEqual(3);
    const [savedId, likedId, rejectedId] = outfits.map((o) => o.id);
    const card = (id: string | undefined) => page.locator(`[data-outfit-id="${id}"]`);

    try {
      await card(savedId).getByRole("button", { name: "Save", exact: true }).click();
      await expect(card(savedId).getByRole("button", { name: "Saved", exact: true })).toHaveAttribute("aria-pressed", "true");

      await card(likedId).getByRole("button", { name: "Like", exact: true }).click();
      await expect(card(likedId).getByRole("button", { name: "Liked", exact: true })).toHaveAttribute("aria-pressed", "true");

      await card(rejectedId).getByRole("button", { name: "Reject", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Not for you?" });
      await dialog.getByLabel("Why not? (optional)").fill("Not my colours");
      const rejected = page.waitForResponse((res) => res.request().method() === "PATCH" && res.url().endsWith(`/api/outfits/${rejectedId}`));
      await dialog.getByRole("button", { name: "Reject outfit" }).click();
      expect((await rejected).status()).toBe(200);
      expect((await rejected).request().postDataJSON()).toEqual({ status: "rejected", reason: "Not my colours" });
      await expect(card(rejectedId)).toHaveAttribute("data-status", "rejected");

      // What the server now holds.
      for (const [id, status] of [
        [savedId, "saved"],
        [likedId, "liked"],
        [rejectedId, "rejected"],
      ] as const) {
        const res = await request.get(`/api/outfits/${id}`);
        expect(OutfitResponseSchema.parse(await res.json()).outfit.status).toBe(status);
      }

      await nav(page).getByRole("link", { name: "Saved" }).click();
      await expect(page).toHaveURL(/\/outfits\/saved$/);
      await expect(page.getByRole("heading", { name: "Saved outfits" })).toBeVisible();
      await expect(card(savedId)).toBeVisible();
      await expect(card(likedId)).toBeVisible();
      await expect(card(rejectedId)).toHaveCount(0);
      await expectCollagesDrawn(page.locator(`[data-outfit-id="${savedId}"], [data-outfit-id="${likedId}"]`));

      // The same list through the API the screen uses.
      const list = OutfitListResponseSchema.parse(await (await request.get("/api/outfits?status=saved")).json());
      expect(list.outfits.map((o) => o.id)).toContain(savedId);
      await expectNoSidewaysScroll(page);
    } finally {
      // Put the statuses back, so a reused server doesn't build up avoid hints.
      for (const id of [savedId, likedId, rejectedId]) {
        await request.patch(`/api/outfits/${id}`, { data: { status: "suggested" } });
      }
    }
  });
});

test.describe("add by link, end to end", () => {
  test("a readable product page: link, tags, save; the item keeps its link", async ({ page, request }) => {
    const link = `https://shop.example.com/products/journey-${Date.now()}`;
    await openApp(page);
    await nav(page).getByRole("link", { name: "Add" }).click();
    await page.getByRole("link", { name: "Paste a product link" }).click();
    await page.getByLabel("Product link").fill(link);
    const step2 = page.waitForResponse((res) => new URL(res.url()).pathname === "/api/items/link/cutout");
    await page.getByRole("button", { name: "Add from link" }).click();
    expect((await step2).status()).toBe(200);

    await expect(page.getByRole("heading", { name: "Check the tags" })).toBeVisible();
    const description = unique("Journey linked shirt");
    await page.getByLabel("Description").fill(description);
    await page.getByRole("button", { name: "Save to wardrobe" }).click();
    await expect(page.getByText("Saved to your wardrobe")).toBeVisible();

    await findInWardrobe(page, description);
    await page.getByRole("link", { name: description }).click();
    await expect(page.getByRole("link", { name: "View the product page" })).toHaveAttribute("href", link);
    const id = new URL(page.url()).pathname.split("/").pop()!;
    const { item } = ItemResponseSchema.parse(await (await request.get(`/api/items/${id}`)).json());
    expect(item).toMatchObject({ source: "link", sourceUrl: link });
  });

  test("a blocked site: screenshot fallback through the photo route to a saved item that keeps its link", async ({ page, request }) => {
    const link = `https://blocked.example.com/p/journey-${Date.now()}`;
    await openApp(page);
    await nav(page).getByRole("link", { name: "Add" }).click();
    await page.getByRole("link", { name: "Paste a product link" }).click();
    await page.getByLabel("Product link").fill(link);
    const step1 = page.waitForResponse((res) => new URL(res.url()).pathname === "/api/items/link");
    await page.getByRole("button", { name: "Add from link" }).click();
    expect(await (await step1).json()).toMatchObject({ status: "needs_screenshot", reason: "fetch_blocked", sourceUrl: link });

    await expect(page.getByRole("heading", { name: "Add a screenshot" })).toBeVisible();
    const photo = page.waitForResponse((res) => res.request().method() === "POST" && new URL(res.url()).pathname === "/api/items/photo");
    await page.getByTestId("photo-library-input").setInputFiles({ name: "screenshot.jpg", mimeType: "image/jpeg", buffer: PHOTO });
    // The screenshot went down the photo route carrying the link, so the draft keeps it.
    const photoRes = await photo;
    expect(photoRes.status()).toBe(200);
    expect((await photoRes.json()).draft).toMatchObject({ source: "link", sourceUrl: link });

    await expect(page.getByRole("heading", { name: "Check the tags" })).toBeVisible();
    const description = unique("Journey screenshot shirt");
    await page.getByLabel("Description").fill(description);
    await page.getByRole("button", { name: "Save to wardrobe" }).click();
    await expect(page.getByText("Saved to your wardrobe")).toBeVisible();

    await findInWardrobe(page, description);
    await page.getByRole("link", { name: description }).click();
    await expect(page.getByRole("link", { name: "View the product page" })).toHaveAttribute("href", link);
    const id = new URL(page.url()).pathname.split("/").pop()!;
    const { item } = ItemResponseSchema.parse(await (await request.get(`/api/items/${id}`)).json());
    expect(item).toMatchObject({ source: "link", sourceUrl: link });
  });
});

test.describe("missing category", () => {
  // Deleting every pair of shoes from the mock store would break the specs
  // running alongside this one (they share one mock user), and there's no
  // mock marker for missing_category. So this test intercepts only the one
  // POST /api/outfits, and answers as the server would for this wardrobe
  // without shoes: computed with the shared missingCategoriesForOutfits from
  // the real wardrobe, and checked against the contract schema.
  test("a wardrobe with no shoes says which category is missing, with a way to add it", async ({ page, request }) => {
    const { items } = await (await request.get("/api/items")).json();
    const present = new Set<Category>(
      (items as { tags: { category: Category } }[]).map((i) => i.tags.category).filter((c) => c !== "shoes"),
    );
    const missingCategories = missingCategoriesForOutfits(present);
    const body = OutfitGenerationResponseSchema.parse({
      status: "incomplete_wardrobe",
      reason: "missing_category",
      missingCategories,
      message: "Add shoes to your wardrobe to get outfits.",
    });

    let intercepted = 0;
    await page.route("**/api/outfits", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      intercepted++;
      await route.fulfill({ json: body });
    });

    await openApp(page);
    await nav(page).getByRole("link", { name: "Outfits" }).click();
    await tapRadio(page, "Casual");
    await page.getByRole("button", { name: "Get outfits" }).click();

    const notice = page.getByTestId("incomplete-wardrobe");
    await expect(notice).toHaveAttribute("data-reason", "missing_category");
    await expect(notice.getByRole("heading", { name: "Your wardrobe needs a few more pieces" })).toBeVisible();
    await expect(notice).toContainText("Add shoes to your wardrobe to get outfits.");
    await expect(outfitCards(page)).toHaveCount(0);
    expect(intercepted).toBe(1);

    // The way out goes to Add.
    await notice.getByRole("link", { name: "Add shoes" }).click();
    await expect(page.getByRole("heading", { name: "Add an item" })).toBeVisible();
    await expectNoSidewaysScroll(page);
  });
});

test.describe("account deletion", () => {
  // The mock DELETE /api/account resets the shared store, which would break
  // every other spec running at the same time, so it's intercepted here.
  test("from the Account sheet, after confirming, the account is deleted and you're signed out", async ({ page }) => {
    let deletes = 0;
    await page.route("**/api/account", async (route) => {
      if (route.request().method() !== "DELETE") return route.continue();
      deletes++;
      await route.fulfill({ json: { deleted: true } });
    });

    await openApp(page);
    await page.getByRole("button", { name: "Account" }).click();
    const sheet = page.getByRole("dialog", { name: "Account" });
    await expect(sheet.getByRole("button", { name: "Sign out" })).toBeVisible();

    // Backing out deletes nothing.
    await sheet.getByRole("button", { name: "Delete my account" }).click();
    const confirm = page.getByRole("alertdialog", { name: "Delete your account?" });
    await expect(confirm).toContainText("You can't undo this.");
    await confirm.getByRole("button", { name: "Keep my account" }).click();
    await expect(confirm).toHaveCount(0);
    expect(deletes).toBe(0);

    await sheet.getByRole("button", { name: "Delete my account" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete everything" }).click();
    await expect(page).toHaveURL(/\/sign-in$/);
    await expect(page.getByRole("heading", { name: "Sign in to GladRags" })).toBeVisible();
    expect(deletes).toBe(1);
  });
});

// Success criterion "a tester can add 20 items in under 15 minutes", from the
// app's side: 20 photos through the real UI with the fake remover. Off by
// default because it adds 20 items to the shared store; run with
// GLADRAGS_TIME_ADD_20=true, ideally on a fresh server. Like the rest of
// this file it only adds data.
test.describe("timing: 20 items by photo", () => {
  test.skip(process.env.GLADRAGS_TIME_ADD_20 !== "true", "set GLADRAGS_TIME_ADD_20=true to time it");

  test("adds 20 items through the photo flow", async ({ page }) => {
    test.setTimeout(300_000);
    const ids: string[] = [];
    page.on("response", async (res) => {
      if (res.request().method() === "POST" && new URL(res.url()).pathname === "/api/items" && res.status() === 201) {
        ids.push((await res.json()).item.id);
      }
    });
    await openApp(page);
    await nav(page).getByRole("link", { name: "Add" }).click();
    const perItem: number[] = [];
    const start = Date.now();
    for (let n = 0; n < 20; n++) {
      const t0 = Date.now();
      await page.getByTestId("photo-library-input").setInputFiles({ name: `IMG_${n}.jpg`, mimeType: "image/jpeg", buffer: PHOTO });
      await expect(page.getByRole("heading", { name: "Check the tags" })).toBeVisible();
      await page.getByLabel("Description").fill(unique(`Timed item ${n}`));
      await page.getByRole("button", { name: "Save to wardrobe" }).click();
      await expect(page.getByText("Saved to your wardrobe")).toBeVisible();
      perItem.push(Date.now() - t0);
    }
    const total = Date.now() - start;
    console.log(`20 items by photo (fake remover, mock tagger): total ${total} ms, per item ${JSON.stringify(perItem)}`);
    await expect.poll(() => ids.length).toBe(20);
  });
});
