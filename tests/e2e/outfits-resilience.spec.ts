import { expect, test, type Page } from "@playwright/test";

// Outfit screens when things go wrong or come back short: anchor load
// errors, expired image URLs, fewer outfits than asked for, a signed-out
// session, and focus. 390 px, mock mode. Outfit responses are intercepted
// with contract-shaped data built from the mock wardrobe, so these tests
// use none of the mock user's daily outfit requests.

const NAVY_BLAZER_ID = "1a000000-0000-4000-8000-000000000008";
/** Any image here answers 403, like a signed URL that has expired. */
const EXPIRED = "/mock/items/expired-url.svg";

interface Item {
  id: string;
  cutoutUrl: string | null;
  originalUrl: string;
  tags: { category: string; description: string };
}

let counter = 0;
const outfitId = () => `5e000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;

async function mockItems(page: Page): Promise<Item[]> {
  const res = await page.request.get("/api/items");
  return ((await res.json()) as { items: Item[] }).items;
}

function outfit(items: Item[], name: string) {
  return {
    id: outfitId(),
    request: { style: { kind: "preset", presetId: "casual" }, guidance: null, anchorItemId: null },
    name,
    reason: "Picked for this test",
    itemIds: items.map((i) => i.id),
    items,
    status: "suggested",
    parentOutfitId: null,
    createdAt: "2026-10-25T10:00:00.000Z",
  };
}

/** A white t-shirt, jeans and trainers from the mock wardrobe. */
async function basicItems(page: Page) {
  const items = await mockItems(page);
  const pick = (description: string) => items.find((i) => i.tags.description.includes(description))!;
  return [pick("White crew-neck"), pick("jeans"), pick("trainers")];
}

async function fakeRequest(page: Page, body: unknown, status = 200) {
  await page.route(/\/api\/outfits$/, (route) =>
    route.request().method() === "POST" ? route.fulfill({ status, json: body }) : route.fallback(),
  );
}

async function tapRadio(page: Page, name: string) {
  await page.getByRole("radio", { name, exact: true }).locator("xpath=ancestor::label[1]").click();
}

async function askFor(page: Page, style = "Casual") {
  await tapRadio(page, style);
  await page.getByRole("button", { name: "Get outfits" }).click();
}

const cards = (page: Page) => page.getByTestId("outfit-card");

test.beforeEach(async ({ page }) => {
  await page.route(`**${EXPIRED}*`, (route) => route.fulfill({ status: 403, body: "expired" }));
  // Let tests move the clock forward (signed URLs expire after an hour)
  // without faking timers, which would stall animations.
  await page.addInitScript(() => {
    const realNow = Date.now.bind(Date);
    (window as unknown as { __timeOffset: number }).__timeOffset = 0;
    Date.now = () => realNow() + (window as unknown as { __timeOffset: number }).__timeOffset;
  });
});

const moveClockOn = (page: Page, minutes: number) =>
  page.evaluate((ms) => ((window as unknown as { __timeOffset: number }).__timeOffset += ms), minutes * 60_000);

test.describe("anchor item that fails to load", () => {
  test("a server error offers Try again, and holds Get outfits until it works", async ({ page }) => {
    let calls = 0;
    await page.route(`**/api/items/${NAVY_BLAZER_ID}`, (route) => {
      calls++;
      return calls === 1
        ? route.fulfill({ status: 500, json: { error: { code: "internal", message: "Database unavailable" } } })
        : route.fallback();
    });
    await page.goto(`/outfits?anchor=${NAVY_BLAZER_ID}`);
    const anchorError = page.getByTestId("anchor-error");
    await expect(anchorError.getByTestId("api-error")).toContainText("Database unavailable");
    // Not silently treated as "deleted".
    await expect(page.getByText("isn't in your wardrobe any more")).toHaveCount(0);
    await tapRadio(page, "Work");
    await expect(page.getByRole("button", { name: "Get outfits" })).toBeDisabled();

    await anchorError.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByTestId("anchor-item")).toContainText("Navy single-breasted blazer");
    await expect(page.getByRole("button", { name: "Get outfits" })).toBeEnabled();
  });

  test("or the user can go on without it", async ({ page }) => {
    await page.route(`**/api/items/${NAVY_BLAZER_ID}`, (route) =>
      route.fulfill({ status: 500, json: { error: { code: "internal", message: "Database unavailable" } } }),
    );
    await fakeRequest(page, { status: "ok", outfits: [outfit(await basicItems(page), "Without anchor")] });
    await page.goto(`/outfits?anchor=${NAVY_BLAZER_ID}`);
    await page.getByRole("button", { name: "Continue without it" }).click();
    await expect(page.getByTestId("anchor-error")).toHaveCount(0);
    const sent = page.waitForRequest((r) => r.method() === "POST" && new URL(r.url()).pathname === "/api/outfits");
    await askFor(page, "Work");
    expect((await sent).postDataJSON()).not.toHaveProperty("anchorItemId");
  });
});

test.describe("expired image URLs", () => {
  test("a 403 image: placeholder, Save disabled, thumbnail fallback, then Reload pictures fixes it", async ({ page }) => {
    const [tshirt, jeans, trainers] = await basicItems(page);
    const expiredTshirt = { ...tshirt!, cutoutUrl: `${EXPIRED}?c`, originalUrl: `${EXPIRED}?o` };
    const stale = outfit([expiredTshirt, jeans!, trainers!], "Stale pictures");
    await fakeRequest(page, { status: "ok", outfits: [stale] });
    let refetched = 0;
    await page.route(`**/api/outfits/${stale.id}`, (route) => {
      refetched++;
      return route.fulfill({ json: { outfit: { ...stale, items: [tshirt, jeans, trainers] } } });
    });

    await page.goto("/outfits");
    await askFor(page);
    const card = cards(page).first();
    const canvas = card.getByTestId("outfit-collage");
    await expect(canvas).toHaveAttribute("data-state", "partial");
    await expect(card.getByText("Some pictures couldn't load.")).toBeVisible();
    await expect(card.getByRole("button", { name: "Save image of Stale pictures" })).toBeDisabled();
    // The thumbnail tried the cut-out, then the original, then shows an icon.
    const row = card.getByRole("listitem").filter({ hasText: "White crew-neck" });
    await expect(row.locator("img")).toHaveCount(0);

    await card.getByRole("button", { name: "Reload pictures" }).click();
    await expect(canvas).toHaveAttribute("data-state", "ready");
    expect(refetched).toBe(1);
    await expect(card.getByRole("button", { name: "Reload pictures" })).toHaveCount(0);
    await expect(card.getByRole("button", { name: "Save image of Stale pictures" })).toBeEnabled();
    await expect(row.locator("img")).toHaveCount(1);
  });

  test("Back re-fetches a set older than 50 minutes; Back waits while a refine runs", async ({ page }) => {
    const items = await basicItems(page);
    const first = outfit(items, "First set");
    await fakeRequest(page, { status: "ok", outfits: [first] });
    let release: () => void = () => {};
    let refines = 0;
    await page.route(/\/refine$/, async (route) => {
      refines++;
      if (refines === 2) await new Promise<void>((resolve) => (release = resolve));
      await route.fulfill({ json: { status: "ok", outfits: [outfit(items, `Refined ${refines}`)] } });
    });
    const refetches: string[] = [];
    await page.route(`**/api/outfits/${first.id}`, (route) => {
      refetches.push(route.request().method());
      return route.fulfill({ json: { outfit: { ...first, name: "First set, fresh" } } });
    });

    await page.goto("/outfits");
    await askFor(page);
    await cards(page).first().getByRole("button", { name: "Swap Mid-blue straight-leg jeans" }).click();
    await expect(page.getByRole("heading", { name: "Refined 1" })).toBeVisible();

    // While another refine runs, Back is held.
    await cards(page).first().getByRole("button", { name: "Swap Mid-blue straight-leg jeans" }).click();
    await expect(page.getByRole("button", { name: "Back to previous ideas" })).toBeDisabled();
    release();
    await expect(page.getByRole("heading", { name: "Refined 2" })).toBeVisible();

    // Within 50 minutes, Back reuses what it has.
    await page.getByRole("button", { name: "Back to previous ideas" }).click();
    await expect(page.getByRole("heading", { name: "Refined 1" })).toBeVisible();
    expect(refetches).toEqual([]);

    // An hour later, it fetches the outfits again for fresh image URLs.
    await moveClockOn(page, 55);
    await page.getByRole("button", { name: "Back to previous ideas" }).click();
    await expect(page.getByRole("heading", { name: "First set, fresh" })).toBeVisible();
    expect(refetches).toEqual(["GET"]);
  });

  test("the saved screen fetches again on a filter change once its URLs may have expired", async ({ page }) => {
    const saved = { ...outfit(await basicItems(page), "Kept"), status: "saved" };
    let loads = 0;
    await page.route(/\/api\/outfits\?status=/, (route) => {
      loads++;
      const status = new URL(route.request().url()).searchParams.get("status");
      return route.fulfill({ json: { outfits: status === "saved" ? [saved] : [] } });
    });
    await page.goto("/outfits/saved");
    await expect(cards(page)).toHaveCount(1);
    expect(loads).toBe(2); // saved + liked
    await page.getByRole("radio", { name: "Saved" }).click();
    expect(loads).toBe(2);
    await moveClockOn(page, 55);
    await page.getByRole("radio", { name: "All" }).click();
    await expect.poll(() => loads).toBe(4);
    await expect(cards(page)).toHaveCount(1);
  });
});

test.describe("fewer outfits than asked for", () => {
  for (const found of [1, 2]) {
    test(`${found} of 4: shown well, with a line explaining why`, async ({ page }) => {
      const items = await basicItems(page);
      const outfits = Array.from({ length: found }, (_, i) => outfit(items, `Only ${i + 1}`));
      await fakeRequest(page, { status: "ok", outfits });
      await page.goto("/outfits");
      await askFor(page);
      await expect(cards(page)).toHaveCount(found);
      await expect(page.getByTestId("fewer-outfits")).toHaveText(
        found === 1
          ? "Only found 1 outfit that fits. Add more items to your wardrobe for more ideas."
          : "Only found 2 that fit. Add more items to your wardrobe for more ideas.",
      );
      await expect(cards(page).first().getByTestId("outfit-collage")).toHaveAttribute("data-state", "ready");
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(0);
    });
  }

  test("the full count gets no such line", async ({ page }) => {
    const items = await basicItems(page);
    await fakeRequest(page, { status: "ok", outfits: [1, 2, 3].map((n) => outfit(items, `Full ${n}`)) });
    await page.goto("/outfits");
    await tapRadio(page, "3 outfits");
    await askFor(page);
    await expect(cards(page)).toHaveCount(3);
    await expect(page.getByTestId("fewer-outfits")).toHaveCount(0);
  });

  test("against the mock engine: Comfy and real Back", async ({ page }) => {
    // The mock engine returns as many as it can; this just checks the line
    // agrees with what came back. Uses 1 of the mock user's daily requests.
    await page.goto("/outfits");
    await askFor(page, "Comfy");
    await expect(cards(page).first()).toBeVisible();
    const shown = await cards(page).count();
    await expect(page.getByTestId("fewer-outfits")).toHaveCount(shown < 4 ? 1 : 0);
  });
});

test.describe("other review fixes", () => {
  test("a signed-out session links to sign-in and back here", async ({ page }) => {
    await fakeRequest(page, { error: { code: "unauthorized", message: "Not signed in" } }, 401);
    await page.goto("/outfits");
    await askFor(page);
    await expect(page.getByRole("link", { name: "Sign in again" })).toHaveAttribute("href", "/sign-in?next=%2Foutfits");
  });

  test("a failed save shows its error on that card, and focus moves to the results heading", async ({ page }) => {
    const items = await basicItems(page);
    await fakeRequest(page, { status: "ok", outfits: [outfit(items, "One"), outfit(items, "Two")] });
    await page.route(/\/api\/outfits\/[^/]+$/, (route) =>
      route.request().method() === "PATCH"
        ? route.fulfill({ status: 500, json: { error: { code: "internal", message: "Database unavailable" } } })
        : route.fallback(),
    );
    await page.goto("/outfits");
    await askFor(page);
    await expect(page.locator("#results-heading")).toBeFocused();
    await cards(page).nth(1).getByRole("button", { name: "Save", exact: true }).click();
    await expect(cards(page).nth(1).getByTestId("api-error")).toContainText("Database unavailable");
    await expect(cards(page).nth(0).getByTestId("api-error")).toHaveCount(0);
  });

  test("a blank or whitespace-only reject reason is left out of the request", async ({ page }) => {
    const target = outfit(await basicItems(page), "Not this one");
    await fakeRequest(page, { status: "ok", outfits: [target] });
    const sent: unknown[] = [];
    await page.route(`**/api/outfits/${target.id}`, async (route) => {
      if (route.request().method() !== "PATCH") return route.fallback();
      const body = route.request().postDataJSON() as { status: string };
      sent.push(body);
      await route.fulfill({ json: { outfit: { ...target, status: body.status } } });
    });
    await page.goto("/outfits");
    await askFor(page);
    const card = cards(page).first();
    for (const reason of ["", "   \n  "]) {
      await card.getByRole("button", { name: "Reject", exact: true }).click();
      await page.getByRole("dialog").getByLabel("Why not? (optional)").fill(reason);
      await page.getByRole("dialog").getByRole("button", { name: "Reject outfit" }).click();
      await expect(card).toHaveAttribute("data-status", "rejected");
      await card.getByRole("button", { name: "Undo" }).click();
      await expect(card).toHaveAttribute("data-status", "suggested");
    }
    expect(sent).toEqual([{ status: "rejected" }, { status: "suggested" }, { status: "rejected" }, { status: "suggested" }]);
  });

  test("style chips: the name is the label, the hint is the description", async ({ page }) => {
    await page.goto("/outfits");
    const work = page.getByRole("radio", { name: "Work", exact: true });
    await expect(work).toHaveAccessibleName("Work");
    await expect(work).toHaveAccessibleDescription("Office, meetings, interviews");
  });

  test("the tweak button controls a panel that's always in the page", async ({ page }) => {
    await fakeRequest(page, { status: "ok", outfits: [outfit(await basicItems(page), "Tweakable")] });
    await page.goto("/outfits");
    await askFor(page);
    const button = cards(page).first().getByRole("button", { name: "Tweak this outfit" });
    const panelId = await button.getAttribute("aria-controls");
    await expect(page.locator(`[id="${panelId}"]`)).toBeHidden();
    await button.click();
    await expect(page.locator(`[id="${panelId}"]`)).toBeVisible();
  });
});
