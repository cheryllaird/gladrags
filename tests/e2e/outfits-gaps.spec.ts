import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import { installFakeBackgroundRemover } from "./helpers";

// Milestone 5 outfit screens on a 390 px phone, in mock mode (task C6):
// "Include items from my shops", gaps in results and collages, "Find in my
// shops" product cards, "I've bought this", saved outfits with gaps, and
// cutting items out the first time a collage needs them.
//
// Mock mode answers includeShopItems (and the mock-gaps marker) with three
// canned outfits that each have a shoes gap; "Find in my shops" gives three
// made-up products per gap (the third without a picture). States with no
// marker (the shop search cap, ai_paused, an empty wardrobe, an item
// without a cut-out) intercept one route with a contract-shaped answer, so
// the shared mock store isn't changed for other tests.

test.beforeEach(async ({ page }) => {
  // Force the download path so "Save image" is testable on desktop Chromium.
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "canShare", { value: undefined, configurable: true });
  });
});

async function tapRadio(page: Page, name: string) {
  const radio = page.getByRole("radio", { name, exact: true });
  await radio.locator("xpath=ancestor::label[1]").click();
  await expect(radio).toBeChecked();
}

/** Ask for casual outfits, optionally with shop items and guidance. Resolves with the request body. */
async function requestOutfits(page: Page, options: { shopItems?: boolean; guidance?: string } = {}) {
  await page.goto("/outfits");
  await tapRadio(page, "Casual");
  if (options.guidance) await page.getByLabel(/Anything else/).fill(options.guidance);
  if (options.shopItems) await page.getByRole("switch", { name: "Include items from my shops" }).check();
  const sent = page.waitForRequest((r) => r.method() === "POST" && new URL(r.url()).pathname === "/api/outfits");
  await page.getByRole("button", { name: "Get outfits" }).click();
  const body = (await sent).postDataJSON() as Record<string, unknown>;
  await expect(page.getByRole("heading", { level: 1, name: "Outfits for Casual" })).toBeVisible();
  return body;
}

const cards = (page: Page) => page.getByTestId("outfit-card");

async function expectCollageReadyAndExportable(card: Locator) {
  const canvas = card.getByTestId("outfit-collage");
  await canvas.scrollIntoViewIfNeeded();
  await expect(canvas).toHaveAttribute("data-state", "ready");
  // Not tainted: shop pictures stay off the canvas, so it can still be saved.
  const exported = await canvas.evaluate((el: HTMLCanvasElement) => el.toDataURL("image/png").length);
  expect(exported).toBeGreaterThan(5_000);
}

async function expectNoSidewaysScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

test.describe("Include items from my shops", () => {
  test("the toggle explains itself, links to choosing shops, and is a 44 px target", async ({ page }) => {
    await page.goto("/outfits");
    const box = page.getByTestId("include-shop-items");
    const toggle = box.getByRole("switch", { name: "Include items from my shops" });
    await expect(toggle).not.toBeChecked();
    await expect(box).toContainText("may suggest one new piece to buy");
    await expect(box.getByRole("link", { name: "Choose your shops" })).toHaveAttribute("href", "/settings");

    const label = box.locator("label").first();
    expect((await label.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect((await box.getByRole("link", { name: "Choose your shops" }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await expectNoSidewaysScroll(page);
  });

  test("on: sends includeShopItems, and outfits come back with a dashed gap in the collage", async ({ page }) => {
    const body = await requestOutfits(page, { shopItems: true });
    expect(body.includeShopItems).toBe(true);
    await expect(page.getByText("With items from your shops")).toBeVisible();

    await expect(cards(page)).toHaveCount(3);
    const first = cards(page).first();
    await expect(first.getByTestId("outfit-collage")).toHaveAttribute("data-gaps", "1");
    await expect(first.getByTestId("outfit-collage")).toHaveAttribute("aria-label", /suggested .+ \(not in your wardrobe\)/);
    await expectCollageReadyAndExportable(first);

    const gapRow = first.getByTestId("gap-row");
    await expect(gapRow).toHaveAttribute("data-category", "shoes");
    await expect(gapRow).toContainText("Suggested shoes: not in your wardrobe");
    // A shop-item gap on a wardrobe with shoes: nothing to add.
    await expect(page.getByTestId("missing-categories")).toHaveCount(0);
    await expectNoSidewaysScroll(page);
  });

  test("off: the flag isn't sent", async ({ page }) => {
    const body = await requestOutfits(page);
    expect(body).not.toHaveProperty("includeShopItems");
  });
});

test.describe("gaps in results", () => {
  test("a missing category says what to add, and a collage with a gap can be saved as an image", async ({ page }) => {
    await requestOutfits(page, { guidance: "mock-gaps" });
    const notice = page.getByTestId("missing-categories");
    await expect(notice).toContainText("Add shoes to your wardrobe to complete these outfits.");
    await expect(notice.getByRole("link", { name: "Add clothes" })).toHaveAttribute("href", "/add");

    const first = cards(page).first();
    await expectCollageReadyAndExportable(first);
    const name = (await first.getByRole("heading", { level: 2 }).textContent())!;
    const download = page.waitForEvent("download");
    await first.getByRole("button", { name: `Save image of ${name}` }).click();
    expect((await download).suggestedFilename()).toMatch(/^gladrags-[a-z0-9-]+\.png$/);
  });

  test("an empty wardrobe points to the get-started checklist", async ({ page }) => {
    await page.route("**/api/outfits", (route) =>
      route.request().method() === "POST"
        ? route.fulfill({
            json: {
              status: "incomplete_wardrobe",
              reason: "empty_wardrobe",
              missingCategories: [],
              message: "Your wardrobe is empty.",
            },
          })
        : route.fallback(),
    );
    await page.goto("/outfits");
    await tapRadio(page, "Work");
    await page.getByRole("button", { name: "Get outfits" }).click();
    const notice = page.getByTestId("incomplete-wardrobe");
    await expect(notice).toHaveAttribute("data-reason", "empty_wardrobe");
    await expect(notice.getByRole("heading", { name: "Add your first piece to get outfits" })).toBeVisible();
    await expect(notice.getByRole("link", { name: "Get started" })).toHaveAttribute("href", "/wardrobe");
    await expect(notice.getByRole("link", { name: "Add clothes" })).toHaveAttribute("href", "/add");
  });
});

test.describe("Find in my shops", () => {
  test("shows up to 3 products per gap; one can be picked, opened in the shop, bought and cleared", async ({ page }) => {
    await requestOutfits(page, { shopItems: true });
    const card = cards(page).first();
    const search = page.waitForResponse((r) => /\/api\/outfits\/[^/]+\/shop-search$/.test(new URL(r.url()).pathname));
    await card.getByRole("button", { name: "Find in my shops" }).click();
    expect((await search).status()).toBe(200);

    const products = card.getByTestId("product-card");
    await expect(products).toHaveCount(3);
    // Title, shop and price on each; a picture on the first two (the third has none).
    await expect(products.first()).toContainText("Next");
    await expect(products.first()).toContainText("£25");
    await expect(products.nth(0).locator("img")).toHaveCount(1);
    await expect(products.nth(2).locator("img")).toHaveCount(0);
    const shopLink = products.first().getByRole("link", { name: /View in Next/ });
    await expect(shopLink).toHaveAttribute("target", "_blank");
    await expect(shopLink).toHaveAttribute("rel", "noopener noreferrer");
    await expect(shopLink).toHaveAttribute("href", /^https:\/\/www\.next\.co\.uk\//);
    await expect(card.getByRole("button", { name: "Search my shops again" })).toBeVisible();
    await expectNoSidewaysScroll(page);

    // Pick the first product.
    const productUrl = (await shopLink.getAttribute("href"))!;
    const title = (await products.first().locator("p").first().textContent())!;
    const pick = page.waitForRequest((r) => r.method() === "PUT" && /\/gaps\/shoes$/.test(new URL(r.url()).pathname));
    await products.first().getByRole("button", { name: "Pick this" }).click();
    expect((await pick).postDataJSON()).toEqual({ productUrl });
    await expect(products.first()).toHaveAttribute("data-chosen", "true");
    await expect(products.first().getByRole("button", { name: "Picked" })).toHaveAttribute("aria-pressed", "true");

    // The collage keeps the dashed placeholder, labelled with the product, and can still be saved.
    const collage = card.getByTestId("outfit-collage");
    await expect(collage).toHaveAttribute("aria-label", new RegExp(`suggested ${escapeRegExp(title)}`));
    await expectCollageReadyAndExportable(card);

    // The gap row shows the pick, with "I've bought this".
    const chosen = card.getByTestId("chosen-product");
    await expect(chosen).toContainText(title);
    const bought = chosen.getByRole("link", { name: "I've bought this" });
    await expect(bought).toHaveAttribute("href", `/add/link?url=${encodeURIComponent(productUrl)}`);
    expect((await bought.boundingBox())!.height).toBeGreaterThanOrEqual(44);

    // Clear the pick.
    await chosen.getByRole("button", { name: "Clear pick" }).click();
    await expect(card.getByTestId("chosen-product")).toHaveCount(0);
    await expect(products.first()).toHaveAttribute("data-chosen", "false");
  });

  test("I've bought this opens add-by-link with the product's link filled in", async ({ page }) => {
    await requestOutfits(page, { shopItems: true });
    const card = cards(page).first();
    await card.getByRole("button", { name: "Find in my shops" }).click();
    const product = card.getByTestId("product-card").first();
    await product.getByRole("button", { name: "Pick this" }).click();
    const productUrl = (await product.getByRole("link", { name: /View in/ }).getAttribute("href"))!;
    await card.getByRole("link", { name: "I've bought this" }).click();

    await expect(page).toHaveURL(/\/add\/link\?url=/);
    expect(new URL(page.url()).searchParams.get("url")).toBe(productUrl);
    await expect
      .poll(() => page.evaluate(() => [...document.querySelectorAll("input, textarea")].map((el) => (el as HTMLInputElement).value)))
      .toContain(productUrl);
  });

  test("the daily shop search cap shows its own notice", async ({ page }) => {
    await page.route("**/api/outfits/*/shop-search", (route) =>
      route.fulfill({
        status: 429,
        json: {
          error: {
            code: "daily_cap_reached",
            message: "You've reached today's limit",
            cap: { kind: "shop_searches_per_day", limit: 10, resetsAt: "2026-11-01T00:00:00.000Z" },
          },
        },
      }),
    );
    await requestOutfits(page, { shopItems: true });
    const card = cards(page).first();
    await card.getByRole("button", { name: "Find in my shops" }).click();
    const notice = card.getByTestId("api-error");
    await expect(notice).toHaveAttribute("data-code", "daily_cap_reached");
    await expect(notice).toContainText("That's today's shop searches used up");
    await expect(notice).toContainText("10 shop searches");
    await expect(card.getByTestId("product-card")).toHaveCount(0);
  });

  test("ai_paused shows that shop search is paused", async ({ page }) => {
    await page.route("**/api/outfits/*/shop-search", (route) =>
      route.fulfill({
        status: 503,
        json: {
          error: {
            code: "ai_paused",
            message: "Paused",
            cap: { kind: "monthly_ai_spend", limit: 500, resetsAt: "2026-11-01T00:00:00.000Z" },
          },
        },
      }),
    );
    await requestOutfits(page, { shopItems: true });
    const card = cards(page).first();
    await card.getByRole("button", { name: "Find in my shops" }).click();
    const notice = card.getByTestId("api-error");
    await expect(notice).toHaveAttribute("data-code", "ai_paused");
    await expect(notice).toContainText("Shop search is paused for now");
    // The outfit itself still works.
    await expectCollageReadyAndExportable(card);
  });
});

test.describe("saved outfits with gaps", () => {
  test("a saved outfit keeps its gap, the picked product and the shop search", async ({ page }) => {
    await requestOutfits(page, { shopItems: true });
    const card = cards(page).first();
    const outfitId = (await card.getAttribute("data-outfit-id"))!;
    await card.getByRole("button", { name: "Find in my shops" }).click();
    await card.getByTestId("product-card").first().getByRole("button", { name: "Pick this" }).click();
    await expect(card.getByTestId("chosen-product")).toBeVisible();
    const title = (await card.getByTestId("product-card").first().locator("p").first().textContent())!;
    const saved = page.waitForResponse((r) => r.request().method() === "PATCH" && r.url().includes(outfitId));
    await card.getByRole("button", { name: "Save", exact: true }).click();
    expect((await saved).status()).toBe(200);

    await page.goto("/outfits/saved");
    const savedCard = page.locator(`[data-testid="outfit-card"][data-outfit-id="${outfitId}"]`);
    await expect(savedCard).toBeVisible();
    await expect(savedCard.getByTestId("gap-row")).toHaveAttribute("data-category", "shoes");
    await expect(savedCard.getByTestId("chosen-product")).toContainText(title);
    await expect(savedCard.getByTestId("outfit-collage")).toHaveAttribute("data-gaps", "1");
    await expectCollageReadyAndExportable(savedCard);
    // The earlier results are still there, and the pick can be cleared here too.
    await expect(savedCard.getByTestId("product-card")).toHaveCount(3);
    await savedCard.getByTestId("chosen-product").getByRole("button", { name: "Clear pick" }).click();
    await expect(savedCard.getByTestId("chosen-product")).toHaveCount(0);
  });
});

test.describe("cut-out on first collage use", () => {
  const COAT_ID = "1a000000-0000-4000-8000-000000000009";
  const SHIRT_ID = "1a000000-0000-4000-8000-000000000001";
  const JEANS_ID = "1a000000-0000-4000-8000-000000000004";
  const TRAINERS_ID = "1a000000-0000-4000-8000-000000000010";

  /** Two outfits that both use the coat, which (in this answer) has no cut-out yet. */
  async function answerWithCoatOutfits(page: Page) {
    const items = await Promise.all(
      [SHIRT_ID, JEANS_ID, TRAINERS_ID, COAT_ID].map(async (id) => {
        const res = await page.request.get(`/api/items/${id}`);
        return ((await res.json()) as { item: { id: string } & Record<string, unknown> }).item;
      }),
    );
    const coat = { ...items[3]!, cutoutUrl: null, needsPhoto: false };
    const [shirt, jeans, trainers] = items;
    const outfit = (n: number) => ({
      id: `2b000000-0000-4000-8000-00000000c0a${n}`,
      request: { style: { kind: "preset", presetId: "casual" }, guidance: null, anchorItemId: null, includeShopItems: false },
      name: `Coat look ${n}`,
      reason: "Layered up for a cold day",
      itemIds: [shirt!.id, jeans!.id, trainers!.id, coat.id],
      items: [shirt, jeans, trainers, coat],
      gaps: [],
      status: "suggested",
      parentOutfitId: null,
      createdAt: "2026-10-31T10:00:00.000Z",
    });
    await page.route("**/api/outfits", (route) =>
      route.request().method() === "POST"
        ? route.fulfill({ json: { status: "ok", outfits: [outfit(1), outfit(2)], missingCategories: [] } })
        : route.fallback(),
    );
    return coat;
  }

  test("cuts the item out once in the browser, uploads it, and never holds up the results", async ({ page }) => {
    await installFakeBackgroundRemover(page);
    const coat = await answerWithCoatOutfits(page);

    const uploads: { body: Buffer | null; contentType: string | undefined }[] = [];
    let releaseUpload!: () => void;
    const uploadHeld = new Promise<void>((resolve) => (releaseUpload = resolve));
    await page.route(`**/api/items/${COAT_ID}/cutout`, async (route: Route) => {
      uploads.push({ body: route.request().postDataBuffer(), contentType: route.request().headers()["content-type"] });
      // Hold the upload: the results must not wait for it.
      await uploadHeld;
      await route.fulfill({ json: { item: { ...coat, cutoutUrl: "/mock/items/uploaded.svg" } } });
    });

    await page.goto("/outfits");
    await tapRadio(page, "Casual");
    await page.getByRole("button", { name: "Get outfits" }).click();
    await expect(cards(page)).toHaveCount(2);
    for (const i of [0, 1]) await expectCollageReadyAndExportable(cards(page).nth(i));

    // One upload for the coat, although two collages use it.
    await expect.poll(() => uploads.length).toBe(1);
    expect(uploads[0]!.contentType).toMatch(/^multipart\/form-data/);
    expect(uploads[0]!.body!.includes(Buffer.from('name="cutout"'))).toBe(true);
    expect(uploads[0]!.body!.includes(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe(true);
    releaseUpload();

    // Asking again draws new collages with the same coat: still no second cut-out.
    await page.getByRole("button", { name: "Change request" }).click();
    await page.getByRole("button", { name: "Get outfits" }).click();
    await expect(cards(page)).toHaveCount(2);
    for (const i of [0, 1]) await expectCollageReadyAndExportable(cards(page).nth(i));
    await page.waitForTimeout(500);
    expect(uploads).toHaveLength(1);
  });

  test("if the upload fails, the collage still shows and nothing is retried", async ({ page }) => {
    await installFakeBackgroundRemover(page);
    await answerWithCoatOutfits(page);
    let uploads = 0;
    await page.route(`**/api/items/${COAT_ID}/cutout`, (route) => {
      uploads++;
      return route.fulfill({ status: 500, json: { error: { code: "internal", message: "Nope" } } });
    });
    await page.goto("/outfits");
    await tapRadio(page, "Casual");
    await page.getByRole("button", { name: "Get outfits" }).click();
    for (const i of [0, 1]) await expectCollageReadyAndExportable(cards(page).nth(i));
    await expect.poll(() => uploads).toBe(1);
    await page.waitForTimeout(300);
    expect(uploads).toBe(1);
    await expect(page.getByTestId("api-error")).toHaveCount(0);
  });
});

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
