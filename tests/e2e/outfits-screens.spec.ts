import { expect, test, type Page } from "@playwright/test";

// Preview screenshots of every outfit screen and state at 390 px, for
// Cheryl. Not a test: skipped unless CAPTURE_SCREENS=true, e.g.
//
//   CAPTURE_SCREENS=true pnpm test:e2e tests/e2e/outfits-screens.spec.ts
//
// Writes PNGs to docs/screens/outfits/. Uses 4 of the mock user's 25 daily
// outfit requests.

const OUT_DIR = "docs/screens/outfits";
const NAVY_BLAZER_ID = "1a000000-0000-4000-8000-000000000008";

test.skip(process.env.CAPTURE_SCREENS !== "true", "Set CAPTURE_SCREENS=true to capture preview screenshots");
test.describe.configure({ mode: "serial" });
test.use({ deviceScaleFactor: 2 });

async function shot(page: Page, name: string, options: { fullPage?: boolean } = {}) {
  // Let fonts, images and the collages settle.
  // (Not "networkidle": link prefetching can keep the network busy.)
  await page.evaluate(() => document.fonts.ready);
  const collages = page.getByTestId("outfit-collage");
  for (let i = 0; i < (await collages.count()); i++) {
    await expect(collages.nth(i)).not.toHaveAttribute("data-state", "loading");
  }
  await page.screenshot({ path: `${OUT_DIR}/${name}.png`, fullPage: options.fullPage ?? false, animations: "disabled" });
}

async function tapRadio(page: Page, name: string) {
  await page.getByRole("radio", { name, exact: true }).locator("xpath=ancestor::label[1]").click();
}

async function fakeOutfitsResponse(page: Page, json: unknown, status = 200) {
  await page.route("**/api/outfits", (route) => route.fulfill({ status, json }));
}

test("request screen", async ({ page }) => {
  await page.goto("/outfits");
  await shot(page, "01-request");
  await tapRadio(page, "Smart casual");
  await page.getByLabel("Anything else? (optional)").fill("no heels");
  await shot(page, "02-request-filled", { fullPage: true });
  await tapRadio(page, "Something else");
  await page.getByLabel("Describe the occasion").fill("first day at a new job");
  await page.getByLabel("Describe the occasion").blur();
  await shot(page, "03-request-custom-style", { fullPage: true });
  await page.getByRole("button", { name: "Get outfits" }).scrollIntoViewIfNeeded();
});

test("request validation", async ({ page }) => {
  await page.goto("/outfits");
  await page.getByRole("button", { name: "Get outfits" }).click();
  await page.getByRole("alert").filter({ hasText: "Pick a style" }).scrollIntoViewIfNeeded();
  await shot(page, "04-request-pick-a-style");
});

test("anchor item: request and results", async ({ page }) => {
  await page.goto(`/outfits?anchor=${NAVY_BLAZER_ID}`);
  await expect(page.getByTestId("anchor-item")).toBeVisible();
  await shot(page, "05-request-anchor");
  await tapRadio(page, "Work");
  await page.getByRole("button", { name: "Get outfits" }).click();
  await expect(page.getByTestId("outfit-card").first()).toBeVisible();
  await shot(page, "06-results-anchor");
});

test("results, tweak, swap, feedback and saved", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "canShare", { value: undefined, configurable: true });
  });
  await page.goto("/outfits");
  await tapRadio(page, "Smart casual");
  await page.getByLabel("Anything else? (optional)").fill("no heels");

  // Hold the response briefly to capture the loading state.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/outfits", async (route) => {
    await held;
    await route.continue();
  });
  await page.getByRole("button", { name: "Get outfits" }).click();
  await expect(page.getByText("Putting outfits together…")).toBeVisible();
  await page.screenshot({ path: `${OUT_DIR}/07-results-loading.png`, animations: "disabled" });
  release();

  const cards = page.getByTestId("outfit-card");
  await expect(cards).toHaveCount(4);
  await shot(page, "08-results");
  await shot(page, "09-results-full", { fullPage: true });

  const first = cards.first();
  await first.getByRole("button", { name: "Tweak this outfit" }).click();
  await first.getByRole("button", { name: "Warmer" }).scrollIntoViewIfNeeded();
  await shot(page, "10-tweak-open");

  // Feedback on the first set.
  await cards.nth(0).getByRole("button", { name: "Save", exact: true }).click();
  await expect(cards.nth(0).getByRole("button", { name: "Saved", exact: true })).toBeVisible();
  await cards.nth(1).getByRole("button", { name: "Like", exact: true }).click();
  await expect(cards.nth(1).getByRole("button", { name: "Liked", exact: true })).toBeVisible();
  await cards.nth(2).getByRole("button", { name: "Reject", exact: true }).click();
  await page.getByLabel("Why not? (optional)").fill("Too dressy for a Sunday");
  await shot(page, "11-reject-dialog");
  await page.getByRole("button", { name: "Reject outfit" }).click();
  await expect(cards.nth(2)).toHaveAttribute("data-status", "rejected");
  await cards.nth(1).scrollIntoViewIfNeeded();
  await shot(page, "12-feedback-given");

  // Swap the shoes on the last outfit.
  const last = cards.nth(3);
  const shoes = last.getByRole("button", { name: /^Swap .*(trainers|loafers|courts)/i }).first();
  await shoes.click();
  await expect(page.getByRole("heading", { name: /^Swapped out the / })).toBeVisible();
  await shot(page, "13-revised-after-swap");

  await page.getByRole("link", { name: "Saved" }).click();
  await expect(page.getByRole("heading", { name: "Saved outfits" })).toBeVisible();
  await expect(page.getByTestId("outfit-card").first()).toBeVisible();
  await shot(page, "14-saved");
});

test("saved: empty", async ({ page }) => {
  await page.route("**/api/outfits?status=*", (route) => route.fulfill({ json: { outfits: [] } }));
  await page.goto("/outfits/saved");
  await expect(page.getByTestId("saved-empty")).toBeVisible();
  await shot(page, "15-saved-empty");
});

test("incomplete wardrobe states", async ({ page }) => {
  await fakeOutfitsResponse(page, {
    status: "incomplete_wardrobe",
    reason: "missing_category",
    missingCategories: ["bottom", "shoes"],
    message: "Add bottom and shoes to your wardrobe to get outfits.",
  });
  await page.goto("/outfits");
  await tapRadio(page, "Casual");
  await page.getByRole("button", { name: "Get outfits" }).click();
  await expect(page.getByTestId("incomplete-wardrobe")).toBeVisible();
  await shot(page, "16-missing-category");

  await page.unroute("**/api/outfits");
  await fakeOutfitsResponse(page, {
    status: "incomplete_wardrobe",
    reason: "nothing_fits",
    missingCategories: [],
    message: "Nothing in your wardrobe works with that yet. Try another style or item.",
  });
  await page.getByRole("button", { name: "Change request" }).first().click();
  await tapRadio(page, "Formal event");
  await page.getByRole("button", { name: "Get outfits" }).click();
  await expect(page.getByTestId("incomplete-wardrobe")).toHaveAttribute("data-reason", "nothing_fits");
  await shot(page, "17-nothing-fits");
});

test("fewer outfits than asked for", async ({ page }) => {
  // Two outfits made from the mock wardrobe, answering a request for four.
  const items = ((await (await page.request.get("/api/items")).json()) as { items: { id: string; tags: { description: string } }[] }).items;
  const pick = (text: string) => items.find((i) => i.tags.description.includes(text))!;
  const make = (n: number, chosen: typeof items) => ({
    id: `5f000000-0000-4000-8000-00000000000${n}`,
    request: { style: { kind: "preset", presetId: "comfy" }, guidance: null, anchorItemId: null },
    name: n === 1 ? "Sofa day" : "Easy errands",
    reason: "Soft layers that are easy to move in",
    itemIds: chosen.map((i) => i.id),
    items: chosen,
    status: "suggested",
    parentOutfitId: null,
    createdAt: "2026-10-25T10:00:00.000Z",
  });
  await fakeOutfitsResponse(page, {
    status: "ok",
    outfits: [
      make(1, [pick("Grey merino"), pick("jeans"), pick("trainers")]),
      make(2, [pick("White crew-neck"), pick("jeans"), pick("trainers")]),
    ],
  });
  await page.goto("/outfits");
  await tapRadio(page, "Comfy");
  await page.getByRole("button", { name: "Get outfits" }).click();
  await expect(page.getByTestId("fewer-outfits")).toBeVisible();
  await shot(page, "21-fewer-outfits");
});

test("error states", async ({ page }) => {
  await page.goto("/outfits");
  await tapRadio(page, "Work");
  await page.getByLabel("Anything else? (optional)").fill("mock-ai-paused");
  await page.getByRole("button", { name: "Get outfits" }).click();
  await expect(page.getByTestId("api-error")).toBeVisible();
  await shot(page, "18-ai-paused");

  await page.getByRole("button", { name: "Change request" }).click();
  await page.getByLabel("Anything else? (optional)").fill("mock-daily-cap");
  await page.getByRole("button", { name: "Get outfits" }).click();
  await expect(page.getByTestId("api-error")).toHaveAttribute("data-code", "daily_cap_reached");
  await shot(page, "19-daily-cap");

  await fakeOutfitsResponse(page, { error: { code: "ai_failed", message: "The model failed twice." } }, 502);
  await page.getByRole("button", { name: "Change request" }).click();
  await page.getByLabel("Anything else? (optional)").fill("");
  await page.getByRole("button", { name: "Get outfits" }).click();
  await expect(page.getByTestId("api-error")).toHaveAttribute("data-code", "ai_failed");
  await shot(page, "20-ai-failed");
});
