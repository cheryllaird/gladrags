import { expect, test, type Locator, type Page, type Request } from "@playwright/test";
import { installFakeBackgroundRemover } from "./helpers";
import { checkPhoneLayout } from "./phone-layout";

// Round 2, P3: generated outfit pictures on the results and saved screens,
// on a 390 px phone viewport, in mock mode. Mock previews "take" about
// 1.2 s each and come back as /mock/previews/preview(-suggested).svg
// (docs/CONTRACTS.md section 1). The mock store is shared by every test
// on the server, so each test picks out its own outfits.
//
// The failure, cap and pause states answer the preview route with the
// contract-shaped error each marker (mock-preview-fails, -cap, -paused)
// stands for. The markers alone aren't reliable in this shared store: an
// outfit whose look another test already pictured reuses that picture
// before the marker is looked at, and a failed look stays failed for an
// hour, which would leak into the other tests. "Pick your model" is reached by answering
// GET /api/settings with modelPresetId: null and the preview route with
// the no-preset bad_request until a preset is saved.

const PREVIEW_PATH = /^\/api\/outfits\/[^/]+\/preview$/;

test.beforeEach(async ({ page }) => {
  await installFakeBackgroundRemover(page);
  // Force the download path so "Save image" is testable on desktop Chromium.
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "canShare", { value: undefined, configurable: true });
  });
});

async function tapRadio(page: Page, name: string) {
  const radio = page.getByRole("radio", { name, exact: true });
  await page.locator("label", { has: radio }).click();
  await expect(radio).toBeChecked();
}

async function requestOutfits(page: Page, options: { guidance?: string; shopItems?: boolean; style?: string } = {}) {
  await page.goto("/outfits");
  await tapRadio(page, options.style ?? "Casual");
  if (options.guidance) await page.getByLabel(/Anything else/).fill(options.guidance);
  if (options.shopItems) await page.getByRole("switch", { name: "Include items from my shops" }).check();
  await page.getByRole("button", { name: "Get outfits" }).click();
  await expect(cards(page).first()).toBeVisible();
}

const cards = (page: Page) => page.getByTestId("outfit-card");
const preview = (card: Locator) => card.getByTestId("outfit-preview");

/** Records every preview POST, and how many were in flight at once. */
function watchPreviewRequests(page: Page) {
  const sent: { outfitId: string; refresh: boolean }[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const isPreview = (r: Request) => r.method() === "POST" && PREVIEW_PATH.test(new URL(r.url()).pathname);
  page.on("request", (r) => {
    if (!isPreview(r)) return;
    const url = new URL(r.url());
    sent.push({ outfitId: url.pathname.split("/")[3]!, refresh: url.searchParams.get("refresh") === "true" });
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
  });
  const done = (r: Request) => {
    if (isPreview(r)) inFlight--;
  };
  page.on("requestfinished", done);
  page.on("requestfailed", done);
  return { sent, maxInFlight: () => maxInFlight };
}

async function outfitIds(page: Page): Promise<string[]> {
  return cards(page).evaluateAll((els) => els.map((el) => el.getAttribute("data-outfit-id")!));
}

test.describe("pictures in results", () => {
  test("each outfit is pictured in turn: the collage first, then the picture, with the pieces a tap away", async ({ page }) => {
    const watch = watchPreviewRequests(page);
    await requestOutfits(page, { guidance: "previews in turn" });
    const first = cards(page).first();

    // The collage is the placeholder while the model is dressed.
    await expect(first.getByText("Dressing your model…")).toBeVisible();
    await expect(first.getByTestId("outfit-collage")).toBeVisible();

    const count = await cards(page).count();
    for (let i = 0; i < count; i++) {
      await expect(preview(cards(page).nth(i))).toHaveAttribute("data-state", "ready", { timeout: 15_000 });
    }
    await expect(first.getByTestId("preview-image")).toHaveAttribute("src", "/mock/previews/preview.svg");
    await expect(first.getByTestId("outfit-collage")).toHaveCount(0);
    // One after another, once per outfit.
    expect(watch.maxInFlight()).toBe(1);
    expect(new Set(watch.sent.map((s) => s.outfitId))).toEqual(new Set(await outfitIds(page)));
    expect(watch.sent.every((s) => !s.refresh)).toBe(true);

    // The item list stays, and the collage is one tap away.
    await expect(first.getByRole("list", { name: "Items in this outfit" })).toBeVisible();
    await first.getByRole("button", { name: "Show the pieces" }).click();
    await expect(first.getByTestId("outfit-collage")).toHaveAttribute("data-state", "ready");
    await expect(first.getByTestId("preview-image")).toHaveCount(0);
    await first.getByRole("button", { name: "Show the picture" }).click();
    await expect(first.getByTestId("preview-image")).toBeVisible();

    // "Save image" saves the picture, as a PNG.
    const name = (await first.getByRole("heading", { level: 2 }).textContent())!;
    const download = page.waitForEvent("download");
    await first.getByRole("button", { name: `Save image of ${name}` }).click();
    expect((await download).suggestedFilename()).toMatch(/^gladrags-.+\.png$/);
    await expect(first.getByText("Image saved to your downloads.")).toBeVisible();

    await checkPhoneLayout(page, "results with pictures");
  });

  test("a swap asks for pictures of the new outfits only", async ({ page }) => {
    const watch = watchPreviewRequests(page);
    await requestOutfits(page, { guidance: "swap pictures" });
    const firstSet = await outfitIds(page);
    for (let i = 0; i < firstSet.length; i++) {
      await expect(preview(cards(page).nth(i))).toHaveAttribute("data-state", "ready", { timeout: 15_000 });
    }
    const before = watch.sent.length;

    await cards(page).first().getByRole("button", { name: /^Swap / }).first().click();
    await expect(page.getByRole("button", { name: "Back to previous ideas" })).toBeVisible();
    const secondSet = await outfitIds(page);
    for (let i = 0; i < secondSet.length; i++) {
      await expect(preview(cards(page).nth(i))).toHaveAttribute("data-state", "ready", { timeout: 15_000 });
    }
    const asked = watch.sent.slice(before).map((s) => s.outfitId);
    expect(new Set(asked)).toEqual(new Set(secondSet.filter((id) => !firstSet.includes(id))));

    // Back to the first set: nothing new is asked for.
    const afterSwap = watch.sent.length;
    await page.getByRole("button", { name: "Back to previous ideas" }).click();
    await expect(preview(cards(page).first())).toHaveAttribute("data-state", "ready");
    expect(watch.sent.length).toBe(afterSwap);
    expect(watch.maxInFlight()).toBe(1);
  });

  test("outfits with a suggested piece say so on the picture", async ({ page }) => {
    await requestOutfits(page, { guidance: "mock-gaps pictured" });
    const first = cards(page).first();
    await expect(preview(first)).toHaveAttribute("data-state", "ready", { timeout: 15_000 });
    await expect(first.getByTestId("preview-image")).toHaveAttribute("src", "/mock/previews/preview-suggested.svg");
    const labels = first.getByRole("list", { name: "Suggested pieces, not from your wardrobe" });
    await expect(labels.getByRole("listitem")).toHaveCount(1);
    await expect(labels).toHaveText(/^.+ suggested$/);
    await expect(first.getByTestId("preview-image")).toHaveAttribute("alt", / suggested\)$/);
  });

  test("picking a shop product marks the picture outdated; Update preview makes a new one, keeping the old one meanwhile", async ({
    page,
  }) => {
    const watch = watchPreviewRequests(page);
    await requestOutfits(page, { shopItems: true, guidance: "update my picture" });
    const card = cards(page).first();
    // QA: wait for every picture in the set, so the next request counted is the refresh.
    const count = await cards(page).count();
    for (let i = 0; i < count; i++) {
      await expect(preview(cards(page).nth(i))).toHaveAttribute("data-state", "ready", { timeout: 15_000 });
    }

    await card.getByRole("button", { name: "Find in my shops" }).click();
    const products = card.getByTestId("product-card");
    await expect(products).toHaveCount(3);
    await products.first().getByRole("button", { name: "Pick this" }).click();
    await expect(products.first()).toHaveAttribute("data-chosen", "true");

    const update = card.getByRole("button", { name: "Update preview" });
    await expect(update).toBeVisible();
    const before = watch.sent.length;
    await update.click();
    // The old picture stays, with "Updating…", until the new one is ready.
    await expect(card.getByTestId("preview-updating")).toBeVisible();
    await expect(card.getByTestId("preview-image")).toBeVisible();
    await expect(card.getByTestId("preview-updating")).toHaveCount(0, { timeout: 15_000 });
    await expect(update).toHaveCount(0);
    expect(watch.sent.slice(before)[0]).toEqual({ outfitId: await card.getAttribute("data-outfit-id"), refresh: true });
    await checkPhoneLayout(page, "results with an updated picture");
  });
});

/** What the mock route answers for each preview marker (docs/CONTRACTS.md, section 1). */
const MARKER_ERRORS = {
  "mock-preview-fails": { status: 502, error: { code: "ai_failed", message: "We couldn't make a picture of this outfit." } },
  "mock-preview-cap": {
    status: 429,
    error: {
      code: "daily_cap_reached",
      message: "Daily cap reached",
      cap: { kind: "outfit_previews_per_day", limit: 12, resetsAt: "2026-11-15T00:00:00.000Z" },
    },
  },
  "mock-preview-paused": {
    status: 503,
    error: {
      code: "ai_paused",
      message: "Paused",
      cap: { kind: "monthly_image_spend", limit: 200, resetsAt: "2026-12-01T00:00:00.000Z" },
    },
  },
} as const;

async function previewsAnswer(page: Page, marker: keyof typeof MARKER_ERRORS) {
  const { status, error } = MARKER_ERRORS[marker];
  await page.route(/\/api\/outfits\/[^/]+\/preview(\?.*)?$/, (route) => route.fulfill({ status, json: { error } }));
}

test.describe("when there's no picture", () => {
  test("a failed picture keeps the collage with a short, kind note", async ({ page }) => {
    await previewsAnswer(page, "mock-preview-fails");
    await requestOutfits(page, { guidance: "mock-preview-fails" });
    const first = cards(page).first();
    await expect(preview(first)).toHaveAttribute("data-reason", "failed", { timeout: 15_000 });
    await expect(first.getByTestId("preview-note")).toContainText("We couldn't picture this one");
    await expect(first.getByTestId("outfit-collage")).toHaveAttribute("data-state", "ready");
    // The collage can still be saved.
    await expect(first.getByRole("button", { name: /^Save image of / })).toBeEnabled();
  });

  test("the daily cap: the collages show, the cap is explained once per card, and no more pictures are asked for", async ({ page }) => {
    const watch = watchPreviewRequests(page);
    await previewsAnswer(page, "mock-preview-cap");
    await requestOutfits(page, { guidance: "mock-preview-cap" });
    const count = await cards(page).count();
    for (let i = 0; i < count; i++) {
      const card = cards(page).nth(i);
      await expect(preview(card)).toHaveAttribute("data-reason", "daily_cap", { timeout: 15_000 });
      await expect(card.getByTestId("preview-note")).toContainText("That's today's outfit pictures used up");
    }
    await expect(cards(page).first().getByTestId("preview-note")).toContainText(/12 a day/);
    expect(watch.sent).toHaveLength(1);
    await checkPhoneLayout(page, "results at the picture cap");
  });

  test("a pause has its own wording", async ({ page }) => {
    await previewsAnswer(page, "mock-preview-paused");
    await requestOutfits(page, { guidance: "mock-preview-paused" });
    const first = cards(page).first();
    await expect(preview(first)).toHaveAttribute("data-reason", "paused", { timeout: 15_000 });
    await expect(first.getByTestId("preview-note")).toContainText("Outfit pictures are paused for now");
    await expect(first.getByTestId("preview-note")).toContainText("Outfit ideas still work");
  });
});

test.describe("Pick your model", () => {
  /** Plays a user with no preset: settings say none, and the preview route refuses until one is saved. */
  async function withoutPreset(page: Page) {
    const saved: unknown[] = [];
    await page.route("**/api/settings", async (route) => {
      const request = route.request();
      if (request.method() === "PUT") {
        saved.push(request.postDataJSON());
        await route.continue();
        return;
      }
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({ response, json: saved.length ? body : { ...body, modelPresetId: null } });
    });
    await page.route(/\/api\/outfits\/[^/]+\/preview(\?.*)?$/, async (route) => {
      if (saved.length) return route.continue();
      await route.fulfill({
        status: 400,
        json: {
          error: {
            code: "bad_request",
            message: "Pick a model for your outfit pictures first.",
            issues: [{ path: "modelPresetId", message: "No model preset picked yet" }],
          },
        },
      });
    });
    return saved;
  }

  test("asks once, with the default preselected; the chosen model is saved and the pictures start", async ({ page }) => {
    const saved = await withoutPreset(page);
    await requestOutfits(page, { guidance: "first pictures" });
    const sheet = page.getByTestId("pick-model-sheet");
    await expect(sheet.getByRole("heading", { name: "Pick your model" })).toBeVisible();
    await expect(sheet.getByRole("radio", { name: "Women's, average build, medium skin tone" })).toBeChecked();
    await expect(cards(page).first().getByText("Pick your model to see this outfit worn.")).toBeAttached();
    await checkPhoneLayout(page, "Pick your model sheet");

    await sheet.locator("label", { has: page.getByRole("radio", { name: "Men's figures", exact: true }) }).click();
    const choice = page.getByRole("radio", { name: "Men's, broad build, deep skin tone", exact: true });
    await sheet.locator("label", { has: choice }).click();
    await expect(choice).toBeChecked();
    await sheet.getByRole("button", { name: "Use this model" }).click();

    await expect(sheet).toHaveCount(0);
    expect(saved).toEqual([{ modelPresetId: "men_broad_deep" }]);
    await expect(preview(cards(page).first())).toHaveAttribute("data-state", "ready", { timeout: 15_000 });
  });

  test("closing the sheet keeps the default", async ({ page }) => {
    const saved = await withoutPreset(page);
    await requestOutfits(page, { guidance: "close the sheet" });
    const sheet = page.getByTestId("pick-model-sheet");
    await expect(sheet.getByRole("heading", { name: "Pick your model" })).toBeVisible();
    await sheet.getByRole("button", { name: "Close" }).click();
    await expect(sheet).toHaveCount(0);
    expect(saved).toEqual([{ modelPresetId: "women_average_medium" }]);
    await expect(preview(cards(page).first())).toHaveAttribute("data-state", "ready", { timeout: 15_000 });
  });
});

test.describe("saved outfits", () => {
  test("show their pictures the same way, with the pieces a tap away", async ({ page }) => {
    await requestOutfits(page, { guidance: "saved with a picture" });
    const card = cards(page).first();
    const id = (await card.getAttribute("data-outfit-id"))!;
    await expect(preview(card)).toHaveAttribute("data-state", "ready", { timeout: 15_000 });
    const save = page.waitForResponse((r) => r.request().method() === "PATCH" && r.url().endsWith(`/api/outfits/${id}`));
    await card.getByRole("group", { name: /^Feedback on / }).getByRole("button", { name: "Save", exact: true }).click();
    expect((await save).status()).toBe(200);

    await page.goto("/outfits/saved");
    const savedCard = page.locator(`[data-testid="outfit-card"][data-outfit-id="${id}"]`);
    await savedCard.scrollIntoViewIfNeeded();
    await expect(preview(savedCard)).toHaveAttribute("data-state", "ready", { timeout: 15_000 });
    await expect(savedCard.getByTestId("preview-image")).toBeVisible();
    await savedCard.getByRole("button", { name: "Show the pieces" }).click();
    await expect(savedCard.getByTestId("outfit-collage")).toBeVisible();
    await checkPhoneLayout(page, "saved outfits with pictures");
  });
});
