import { expect, test, type Locator, type Page, type Request } from "@playwright/test";

// Outfit screens (journeys 2–5) on a 390 px phone viewport, in mock mode.
//
// The mock store is shared by every test on the server, so these tests
// pick out their own outfits by ID and never assume a list is empty.
//
// Each run makes about 10 outfit requests against the mock user's daily
// cap of 25 (markers and intercepted routes don't count). Restart a
// long-lived local dev server (reuseExistingServer) between runs, or the
// later tests will see daily_cap_reached.
//
// States the mock API has no marker for (ai_failed, missing_category,
// nothing_fits, an empty saved list) are reached by intercepting the
// route with a contract-shaped response.

const NAVY_BLAZER = { id: "1a000000-0000-4000-8000-000000000008", description: "Navy single-breasted blazer" };

const PRESET_LABELS = [
  "Comfy",
  "Active",
  "Casual",
  "Holiday",
  "Smart casual",
  "Work",
  "Evening out",
  "Wedding guest",
  "Formal event",
];

test.beforeEach(async ({ page }) => {
  // Desktop Chromium may offer the Web Share API; force the download path so
  // "Save image" is testable.
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "canShare", { value: undefined, configurable: true });
  });
});

/** Tap a chip the way a person does: on its label (the radio inside is visually hidden). */
async function tapRadio(page: Page, name: string) {
  const radio = page.getByRole("radio", { name, exact: true });
  await radio.locator("xpath=ancestor::label[1]").click();
  await expect(radio).toBeChecked();
}

function chooseStyle(page: Page, label: string) {
  return tapRadio(page, label);
}

function getOutfits(page: Page) {
  return page.getByRole("button", { name: "Get outfits" }).click();
}

const outfitCards = (page: Page) => page.getByTestId("outfit-card");

function waitForApi(page: Page, method: string, path: RegExp): Promise<Request> {
  return page.waitForRequest((req) => req.method() === method && path.test(new URL(req.url()).pathname));
}

/** Every collage drawn, and drawn without tainting the canvas (so "Save image" works). */
async function expectCollagesDrawn(cards: Locator) {
  const count = await cards.count();
  for (let i = 0; i < count; i++) {
    const canvas = cards.nth(i).getByTestId("outfit-collage");
    // Collages on long lists only draw near the screen.
    await canvas.scrollIntoViewIfNeeded();
    await expect(canvas).toHaveAttribute("data-state", "ready");
    const exported = await canvas.evaluate((el: HTMLCanvasElement) => el.toDataURL("image/png").length);
    expect(exported).toBeGreaterThan(5_000);
  }
}

async function expectNoSidewaysScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

test.describe("request screen", () => {
  test("shows the nine presets with hints, a free-text option, guidance and a count of 4", async ({ page }) => {
    await page.goto("/outfits");
    await expect(page.getByRole("heading", { name: "Outfit ideas" })).toBeVisible();
    for (const label of PRESET_LABELS) {
      await expect(page.getByRole("radio", { name: label, exact: true })).toBeVisible();
    }
    await expect(page.getByText("Office, meetings, interviews")).toBeVisible();
    await expect(page.getByRole("radio", { name: "Something else" })).toBeVisible();
    await expect(page.getByLabel("Anything else? (optional)")).toBeVisible();
    await expect(page.getByRole("radio", { name: "4 outfits" })).toBeChecked();
    await expectNoSidewaysScroll(page);
  });

  test("every control is at least 44 px tall", async ({ page }) => {
    await page.goto("/outfits");
    await chooseStyle(page, "Something else");
    const targets = page.locator("main").locator("button, a, label:has(input[type=radio])");
    const count = await targets.count();
    expect(count).toBeGreaterThan(12);
    for (let i = 0; i < count; i++) {
      const box = await targets.nth(i).boundingBox();
      expect(box?.height, await targets.nth(i).innerText()).toBeGreaterThanOrEqual(44);
    }
  });

  test("asks for a style before sending anything", async ({ page }) => {
    let sent = false;
    page.on("request", (req) => {
      if (req.method() === "POST" && req.url().includes("/api/outfits")) sent = true;
    });
    await page.goto("/outfits");
    await getOutfits(page);
    await expect(page.getByRole("alert").filter({ hasText: "Pick a style" })).toBeVisible();
    expect(sent).toBe(false);
  });
});

test.describe("journey 2: outfits for an occasion", () => {
  test("preset + guidance gives 4 collages, each with a name and a reason, and saves as an image", async ({ page }) => {
    await page.goto("/outfits");
    await chooseStyle(page, "Smart casual");
    await page.getByLabel("Anything else? (optional)").fill("no heels");

    const sent = waitForApi(page, "POST", /^\/api\/outfits$/);
    await getOutfits(page);
    expect((await sent).postDataJSON()).toEqual({
      style: { kind: "preset", presetId: "smart_casual" },
      guidance: "no heels",
      count: 4,
    });

    await expect(page.getByRole("heading", { name: "Outfits for Smart casual" })).toBeVisible();
    await expect(page.getByText("“no heels”")).toBeVisible();
    const cards = outfitCards(page);
    await expect(cards).toHaveCount(4);
    for (let i = 0; i < 4; i++) {
      await expect(cards.nth(i).getByRole("heading", { level: 2 })).not.toBeEmpty();
      await expect(cards.nth(i).getByText(/^Mock suggestion: /)).toBeVisible();
    }
    await expectCollagesDrawn(cards);
    await expectNoSidewaysScroll(page);

    const name = await cards.first().getByRole("heading", { level: 2 }).innerText();
    const download = page.waitForEvent("download");
    await cards.first().getByRole("button", { name: `Save image of ${name}` }).click();
    expect((await download).suggestedFilename()).toMatch(/^gladrags-[a-z0-9-]+\.png$/);
  });

  test("a free-text style with 3 outfits", async ({ page }) => {
    await page.goto("/outfits");
    await chooseStyle(page, "Something else");
    await page.getByLabel("Describe the occasion").fill("first day at a new job");
    await tapRadio(page, "3 outfits");

    const sent = waitForApi(page, "POST", /^\/api\/outfits$/);
    await getOutfits(page);
    expect((await sent).postDataJSON()).toEqual({ style: { kind: "custom", text: "first day at a new job" }, count: 3 });
    await expect(page.getByRole("heading", { name: "Outfits for “first day at a new job”" })).toBeVisible();
    await expect(outfitCards(page)).toHaveCount(3);

    // "Change request" goes back with the answers kept.
    await page.getByRole("button", { name: "Change request" }).click();
    await expect(page.getByLabel("Describe the occasion")).toHaveValue("first day at a new job");
  });
});

test.describe("journey 3: build around an item", () => {
  test("?anchor= shows the item, sends it, and every outfit includes it", async ({ page }) => {
    await page.goto(`/outfits?anchor=${NAVY_BLAZER.id}`);
    const anchor = page.getByTestId("anchor-item");
    await expect(anchor).toContainText("Building outfits around");
    await expect(anchor).toContainText(NAVY_BLAZER.description);

    await chooseStyle(page, "Work");
    const sent = waitForApi(page, "POST", /^\/api\/outfits$/);
    await getOutfits(page);
    expect((await sent).postDataJSON()).toMatchObject({ anchorItemId: NAVY_BLAZER.id });

    await expect(page.getByText(`With your ${NAVY_BLAZER.description.toLowerCase()}`)).toBeVisible();
    const cards = outfitCards(page);
    await expect(cards.first()).toBeVisible();
    const count = await cards.count();
    expect(count).toBeGreaterThanOrEqual(3);
    for (let i = 0; i < count; i++) {
      const items = cards.nth(i).getByRole("list", { name: "Items in this outfit" });
      const blazerRow = items.getByRole("listitem").filter({ hasText: NAVY_BLAZER.description });
      await expect(blazerRow).toContainText("Your pick");
      // You can't swap out the item you asked to build around.
      await expect(blazerRow.getByRole("button", { name: /^Swap/ })).toHaveCount(0);
    }
    await expectCollagesDrawn(cards);
  });

  test("the anchor can be removed before asking", async ({ page }) => {
    await page.goto(`/outfits?anchor=${NAVY_BLAZER.id}`);
    await expect(page.getByTestId("anchor-item")).toBeVisible();
    await page.getByRole("button", { name: "Don't build around this item" }).click();
    await expect(page.getByTestId("anchor-item")).toHaveCount(0);
    await expect(page).toHaveURL(/\/outfits$/);
  });

  test("an anchor that no longer exists falls back to the whole wardrobe", async ({ page }) => {
    await page.goto("/outfits?anchor=1a000000-0000-4000-8000-0000000000ff");
    await expect(page.getByText("isn't in your wardrobe any more")).toBeVisible();
  });
});

test.describe("journey 4: refine", () => {
  test("swap one item: a revised set without it, and back to the previous ideas", async ({ page }) => {
    await page.goto("/outfits");
    await chooseStyle(page, "Casual");
    await getOutfits(page);
    const cards = outfitCards(page);
    await expect(cards).toHaveCount(4);
    const firstSetIds = await cards.evaluateAll((els) => els.map((el) => el.getAttribute("data-outfit-id")));

    const first = cards.first();
    const shoesRow = first.getByRole("listitem").filter({ hasText: /Shoes|Trainers|Loafers|Heels/ }).first();
    const shoes = await shoesRow.locator("p").first().innerText();

    const sent = waitForApi(page, "POST", /^\/api\/outfits\/[^/]+\/refine$/);
    await first.getByRole("button", { name: `Swap ${shoes}` }).click();
    const refine = await sent;
    expect(refine.postDataJSON()).toMatchObject({ kind: "swap" });
    expect(new URL(refine.url()).pathname).toBe(`/api/outfits/${firstSetIds[0]}/refine`);

    await expect(page.getByRole("heading", { name: `Swapped out the ${shoes.toLowerCase()}` })).toBeVisible();
    await expect(cards.first()).toBeVisible();
    for (const id of await cards.evaluateAll((els) => els.map((el) => el.getAttribute("data-outfit-id")))) {
      expect(firstSetIds).not.toContain(id);
    }
    await expect(page.getByRole("listitem").filter({ hasText: shoes })).toHaveCount(0);
    await expectCollagesDrawn(cards);

    await page.getByRole("button", { name: "Back to previous ideas" }).click();
    await expect(page.getByRole("heading", { name: "Outfits for Casual" })).toBeVisible();
    expect(await cards.evaluateAll((els) => els.map((el) => el.getAttribute("data-outfit-id")))).toEqual(firstSetIds);
  });

  test("guidance refine: a quick 'Warmer', then typed guidance, then a cap error keeps the set", async ({ page }) => {
    await page.goto("/outfits");
    await chooseStyle(page, "Smart casual");
    await getOutfits(page);
    const cards = outfitCards(page);
    await expect(cards).toHaveCount(4);

    let sent = waitForApi(page, "POST", /\/refine$/);
    await cards.first().getByRole("button", { name: "Tweak this outfit" }).click();
    await cards.first().getByRole("button", { name: "Warmer" }).click();
    expect((await sent).postDataJSON()).toEqual({ kind: "guidance", text: "warmer" });
    await expect(page.getByRole("heading", { name: "Tweaked: warmer" })).toBeVisible();
    await expect(page.getByText(/^New ideas based on /)).toBeVisible();
    await expect(cards.first()).toBeVisible();

    sent = waitForApi(page, "POST", /\/refine$/);
    await cards.first().getByRole("button", { name: "Tweak this outfit" }).click();
    await cards.first().getByPlaceholder("Or say what to change").fill("less formal");
    await cards.first().getByRole("button", { name: "Update" }).click();
    expect((await sent).postDataJSON()).toEqual({ kind: "guidance", text: "less formal" });
    await expect(page.getByRole("heading", { name: "Tweaked: less formal" })).toBeVisible();

    // The daily cap on a refinement: a friendly message, and the outfits stay.
    const before = await cards.count();
    await cards.first().getByRole("button", { name: "Tweak this outfit" }).click();
    await cards.first().getByPlaceholder("Or say what to change").fill("warmer mock-daily-cap");
    await cards.first().getByRole("button", { name: "Update" }).click();
    await expect(page.getByTestId("api-error")).toHaveAttribute("data-code", "daily_cap_reached");
    await expect(page.getByRole("heading", { name: "Tweaked: less formal" })).toBeVisible();
    await expect(cards).toHaveCount(before);
  });
});

test.describe("journey 5: save, like and reject", () => {
  test("feedback is sent, and saved and liked outfits appear on the saved screen", async ({ page }) => {
    await page.goto("/outfits");
    await chooseStyle(page, "Evening out");
    await getOutfits(page);
    const cards = outfitCards(page);
    await expect(cards).toHaveCount(4);
    const [savedId, likedId, rejectedId] = await cards.evaluateAll((els) =>
      els.slice(0, 3).map((el) => el.getAttribute("data-outfit-id")!),
    );

    // Save the first.
    let patch = waitForApi(page, "PATCH", new RegExp(`/api/outfits/${savedId}$`));
    await cards.nth(0).getByRole("button", { name: "Save", exact: true }).click();
    expect((await patch).postDataJSON()).toEqual({ status: "saved" });
    await expect(cards.nth(0).getByRole("button", { name: "Saved", exact: true })).toHaveAttribute("aria-pressed", "true");

    // Like the second.
    patch = waitForApi(page, "PATCH", new RegExp(`/api/outfits/${likedId}$`));
    await cards.nth(1).getByRole("button", { name: "Like", exact: true }).click();
    expect((await patch).postDataJSON()).toEqual({ status: "liked" });
    await expect(cards.nth(1).getByRole("button", { name: "Liked", exact: true })).toHaveAttribute("aria-pressed", "true");

    // Reject the third, with a reason; then undo; then reject without one.
    const third = page.locator(`[data-outfit-id="${rejectedId}"]`);
    await third.getByRole("button", { name: "Reject", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Not for you?" });
    await dialog.getByLabel("Why not? (optional)").fill("Too dressy for me");
    patch = waitForApi(page, "PATCH", new RegExp(`/api/outfits/${rejectedId}$`));
    await dialog.getByRole("button", { name: "Reject outfit" }).click();
    expect((await patch).postDataJSON()).toEqual({ status: "rejected", reason: "Too dressy for me" });
    await expect(third).toHaveAttribute("data-status", "rejected");
    await expect(third).toContainText("You rejected");

    patch = waitForApi(page, "PATCH", new RegExp(`/api/outfits/${rejectedId}$`));
    await third.getByRole("button", { name: "Undo" }).click();
    expect((await patch).postDataJSON()).toEqual({ status: "suggested" });
    await expect(third).toHaveAttribute("data-status", "suggested");

    await third.getByRole("button", { name: "Reject", exact: true }).click();
    patch = waitForApi(page, "PATCH", new RegExp(`/api/outfits/${rejectedId}$`));
    await page.getByRole("dialog").getByRole("button", { name: "Reject outfit" }).click();
    expect((await patch).postDataJSON()).toEqual({ status: "rejected" });

    // The saved screen lists the saved and liked ones, with collages, but not the rejected one.
    await page.getByRole("link", { name: "Saved" }).click();
    await expect(page.getByRole("heading", { name: "Saved outfits" })).toBeVisible();
    const saved = page.locator(`[data-outfit-id="${savedId}"]`);
    const liked = page.locator(`[data-outfit-id="${likedId}"]`);
    await expect(saved).toBeVisible();
    await expect(liked).toBeVisible();
    await expect(page.locator(`[data-outfit-id="${rejectedId}"]`)).toHaveCount(0);
    await expect(saved.getByText("For Evening out")).toBeVisible();
    await expectCollagesDrawn(page.locator(`[data-outfit-id="${savedId}"], [data-outfit-id="${likedId}"]`));
    await expect(saved.getByRole("button", { name: "Reject" })).toHaveCount(0);
    await expect(saved.getByRole("button", { name: /^Swap/ })).toHaveCount(0);

    await page.getByRole("radio", { name: "Liked" }).click();
    await expect(liked).toBeVisible();
    await expect(saved).toHaveCount(0);
    await expectNoSidewaysScroll(page);
  });

  test("the saved screen explains itself when nothing is saved", async ({ page }) => {
    await page.route("**/api/outfits?status=*", (route) => route.fulfill({ json: { outfits: [] } }));
    await page.goto("/outfits/saved");
    await expect(page.getByTestId("saved-empty")).toContainText("Nothing saved yet");
    await page.getByRole("link", { name: "Get outfit ideas" }).click();
    await expect(page).toHaveURL(/\/outfits$/);
  });
});

test.describe("when outfits can't be made", () => {
  test("missing_category: says what to add, with links to add it", async ({ page }) => {
    await page.route("**/api/outfits", (route) =>
      route.fulfill({
        json: {
          status: "incomplete_wardrobe",
          reason: "missing_category",
          missingCategories: ["bottom", "shoes"],
          message: "Add bottom and shoes to your wardrobe to get outfits.",
        },
      }),
    );
    await page.goto("/outfits");
    await chooseStyle(page, "Casual");
    await getOutfits(page);
    const notice = page.getByTestId("incomplete-wardrobe");
    await expect(notice).toHaveAttribute("data-reason", "missing_category");
    await expect(notice.getByRole("heading", { name: "Your wardrobe needs a few more pieces" })).toBeVisible();
    await expect(notice.getByRole("link", { name: "Add shoes" })).toHaveAttribute("href", "/add");
    await expect(notice.getByRole("link", { name: "Add trousers, jeans or a skirt" })).toHaveAttribute("href", "/add");
  });

  test("nothing_fits: suggests changing the request, which keeps the answers", async ({ page }) => {
    await page.route("**/api/outfits", (route) =>
      route.fulfill({
        json: {
          status: "incomplete_wardrobe",
          reason: "nothing_fits",
          missingCategories: [],
          message: "Nothing in your wardrobe works with that yet. Try another style or item.",
        },
      }),
    );
    await page.goto("/outfits");
    await chooseStyle(page, "Formal event");
    await getOutfits(page);
    const notice = page.getByTestId("incomplete-wardrobe");
    await expect(notice).toHaveAttribute("data-reason", "nothing_fits");
    await notice.getByRole("button", { name: "Change request" }).click();
    await expect(page.getByRole("radio", { name: "Formal event" })).toBeChecked();
  });
});

test.describe("errors", () => {
  test("ai_paused: a friendly monthly-pause message, with a way to saved outfits", async ({ page }) => {
    await page.goto("/outfits");
    await chooseStyle(page, "Work");
    await page.getByLabel("Anything else? (optional)").fill("mock-ai-paused");
    await getOutfits(page);
    const error = page.getByTestId("api-error");
    await expect(error).toHaveAttribute("data-code", "ai_paused");
    await expect(error).toContainText("Outfit ideas are paused for now");
    await expect(error).toContainText("Your wardrobe and saved outfits still work");
    await expect(error.getByRole("button", { name: "Try again" })).toHaveCount(0);
    await expect(error.getByRole("link", { name: "See saved outfits" })).toBeVisible();
  });

  test("daily_cap_reached: the limit and when it resets", async ({ page }) => {
    await page.goto("/outfits");
    await chooseStyle(page, "Something else");
    await page.getByLabel("Describe the occasion").fill("mock-daily-cap");
    await getOutfits(page);
    const error = page.getByTestId("api-error");
    await expect(error).toHaveAttribute("data-code", "daily_cap_reached");
    await expect(error).toContainText("today's limit of 25 outfit requests");
    await expect(error).toContainText(/resets at \w{3} \d{1,2} \w{3}, 00:00/);
  });

  test("ai_failed: offers to try again, which then works", async ({ page }) => {
    let calls = 0;
    await page.route("**/api/outfits", async (route) => {
      calls += 1;
      if (calls === 1) {
        await route.fulfill({
          status: 502,
          json: { error: { code: "ai_failed", message: "The model failed twice." } },
        });
      } else {
        await route.continue();
      }
    });
    await page.goto("/outfits");
    await chooseStyle(page, "Holiday");
    await getOutfits(page);
    const error = page.getByTestId("api-error");
    await expect(error).toHaveAttribute("data-code", "ai_failed");
    await expect(error).toContainText("We couldn't put outfits together");
    await error.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByTestId("api-error")).toHaveCount(0);
    await expect(outfitCards(page)).toHaveCount(4);
  });
});
