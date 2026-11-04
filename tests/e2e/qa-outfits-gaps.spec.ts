import {
  expect,
  test,
  type Locator,
  type Page,
  type Route,
} from "@playwright/test";
import { installFakeBackgroundRemover } from "./helpers";

// QA for the milestone 5 outfit screens (task C6), on a 390 px phone in mock
// mode. Adversarial cases on top of outfits-gaps.spec.ts: every gap layout
// with 1 to 3 gaps, long and non-ASCII text, hostile shop products, a gap
// with no results, the shop toggle through refine, and the cut-out queue's
// failure paths.
//
// Answers the mock store can't give (several gaps, hostile products) are
// served by intercepting one route with a contract-shaped answer built from
// the mock wardrobe, so the shared mock store isn't changed for other tests.
// Known bugs are pinned with test.fail() and named "BUG:".

// The service worker could answer requests before page.route sees them.
test.use({ serviceWorkers: "block" });

test.beforeEach(async ({ page }) => {
  // Force the download path so "Save image" is testable on desktop Chromium.
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "canShare", {
      value: undefined,
      configurable: true,
    });
  });
});

const ID = {
  tshirt: "1a000000-0000-4000-8000-000000000001",
  shirt: "1a000000-0000-4000-8000-000000000002",
  jeans: "1a000000-0000-4000-8000-000000000004",
  dress: "1a000000-0000-4000-8000-000000000007",
  blazer: "1a000000-0000-4000-8000-000000000008",
  coat: "1a000000-0000-4000-8000-000000000009",
  trainers: "1a000000-0000-4000-8000-000000000010",
} as const;

type Item = {
  id: string;
  tags: { category: string; description: string };
} & Record<string, unknown>;
type Product = {
  shopId: string;
  title: string;
  url: string;
  priceText: string | null;
  imageUrl: string | null;
};
type Gap = {
  category: string;
  subcategory: string | null;
  colours: string[];
  description: string;
  shopResults: Product[];
  searchedAt: string | null;
  shopProduct: Product | null;
};

async function getItems(page: Page, ids: readonly string[]): Promise<Item[]> {
  return Promise.all(
    ids.map(async (id) => {
      const res = await page.request.get(`/api/items/${id}`);
      expect(res.ok()).toBe(true);
      return ((await res.json()) as { item: Item }).item;
    }),
  );
}

function gap(category: string, overrides: Partial<Gap> = {}): Gap {
  return {
    category,
    subcategory: null,
    colours: ["navy", "white"],
    description: `Suggested ${category.replace("_", " ")}`,
    shopResults: [],
    searchedAt: null,
    shopProduct: null,
    ...overrides,
  };
}

let outfitCounter = 0;
function outfit(
  name: string,
  items: Item[],
  gaps: Gap[],
  overrides: Record<string, unknown> = {},
) {
  outfitCounter++;
  return {
    id: `2b000000-0000-4000-8000-${String(900_000 + outfitCounter).padStart(12, "0")}`,
    request: {
      style: { kind: "preset", presetId: "casual" },
      guidance: null,
      anchorItemId: null,
      includeShopItems: false,
    },
    name,
    reason: "Picked by QA",
    itemIds: items.map((i) => i.id),
    items,
    gaps,
    status: "suggested",
    parentOutfitId: null,
    createdAt: "2026-10-31T10:00:00.000Z",
    ...overrides,
  };
}

/** Answer POST /api/outfits with these outfits. */
async function answerOutfits(
  page: Page,
  outfits: unknown[],
  missingCategories: string[] = [],
) {
  await page.route("**/api/outfits", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({ json: { status: "ok", outfits, missingCategories } })
      : route.fallback(),
  );
}

async function tapRadio(page: Page, name: string) {
  const radio = page.getByRole("radio", { name, exact: true });
  await radio.locator("xpath=ancestor::label[1]").click();
  await expect(radio).toBeChecked();
}

async function askForCasual(
  page: Page,
  options: { shopItems?: boolean; guidance?: string } = {},
) {
  await page.goto("/outfits");
  await tapRadio(page, "Casual");
  if (options.guidance)
    await page.getByLabel(/Anything else/).fill(options.guidance);
  if (options.shopItems)
    await page
      .getByRole("switch", { name: "Include items from my shops" })
      .check();
  const sent = page.waitForRequest(
    (r) =>
      r.method() === "POST" && new URL(r.url()).pathname === "/api/outfits",
  );
  await page.getByRole("button", { name: "Get outfits" }).click();
  const body = (await sent).postDataJSON() as Record<string, unknown>;
  await expect(
    page.getByRole("heading", { level: 1, name: "Outfits for Casual" }),
  ).toBeVisible();
  return body;
}

const cards = (page: Page) => page.getByTestId("outfit-card");

async function expectCollageReadyAndExportable(card: Locator) {
  const canvas = card.getByTestId("outfit-collage");
  await canvas.scrollIntoViewIfNeeded();
  await expect(canvas).toHaveAttribute("data-state", "ready");
  const exported = await canvas.evaluate(
    (el: HTMLCanvasElement) => el.toDataURL("image/png").length,
  );
  expect(exported).toBeGreaterThan(5_000);
}

async function expectSaveImageDownloads(page: Page, card: Locator) {
  const name = (await card.getByRole("heading", { level: 2 }).textContent())!;
  const download = page.waitForEvent("download");
  await card.getByRole("button", { name: `Save image of ${name}` }).click();
  expect((await download).suggestedFilename()).toMatch(
    /^gladrags-[a-z0-9-]+\.png$/,
  );
  await expect(card).not.toContainText("Couldn't save this image");
}

/** No sideways page scroll, and no text in `scope` wider than its own box (clipped or spilling). */
async function expectFitsPhone(page: Page, scope: Locator) {
  const overflow = await page.evaluate(() => {
    const extra = document.documentElement.scrollWidth - window.innerWidth;
    if (extra <= 0) return { extra, widest: [] as string[] };
    // Name the innermost elements that stick out, to make a failure easy to act on.
    const widest = [...document.querySelectorAll<HTMLElement>("body *")]
      .filter(
        (el) => el.getBoundingClientRect().right > window.innerWidth + 0.5,
      )
      .filter(
        (el) =>
          ![...el.children].some(
            (c) => c.getBoundingClientRect().right > window.innerWidth + 0.5,
          ),
      )
      .slice(0, 5)
      .map(
        (el) =>
          `${el.tagName.toLowerCase()}.${el.className.toString().slice(0, 60)}: ${el.textContent?.slice(0, 40)}`,
      );
    return { extra, widest };
  });
  expect(overflow, "page scrolls sideways").toEqual({
    extra: expect.any(Number),
    widest: [],
  });
  expect(overflow.extra).toBeLessThanOrEqual(0);
  const spills = await scope.evaluateAll((roots) => {
    const bad: string[] = [];
    for (const root of roots) {
      for (const el of root.querySelectorAll<HTMLElement>(
        "p, h2, h3, span, a, button",
      )) {
        if (el.offsetParent === null) continue;
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        // Text clipped on purpose (truncate, line-clamp, sr-only) has overflow hidden: not a spill.
        const spillsOut =
          style.overflowX === "visible" &&
          style.display !== "inline" &&
          el.scrollWidth > el.clientWidth + 1;
        if (rect.right > window.innerWidth + 0.5 || spillsOut) {
          bad.push(
            `${el.tagName.toLowerCase()}: ${el.textContent?.slice(0, 40)}`,
          );
        }
      }
    }
    return bad;
  });
  expect(spills, "text wider than its box").toEqual([]);
}

// ---------------------------------------------------------------------------
// Gap layouts in the collage
// ---------------------------------------------------------------------------

test.describe("gap layouts at 390 px", () => {
  test("1 to 3 gaps in every slot: each collage is drawn, exportable, and lists every gap", async ({
    page,
  }) => {
    const [tshirt, jeans, dress, blazer, trainers] = await getItems(page, [
      ID.tshirt,
      ID.jeans,
      ID.dress,
      ID.blazer,
      ID.trainers,
    ]);
    const cases = [
      { name: "Shoes gap", items: [tshirt!, jeans!], gaps: [gap("shoes")] },
      { name: "Top gap", items: [jeans!, trainers!], gaps: [gap("top")] },
      {
        name: "Bottom gap",
        items: [tshirt!, trainers!],
        gaps: [gap("bottom")],
      },
      { name: "Dress gap", items: [trainers!], gaps: [gap("dress_jumpsuit")] },
      {
        name: "Outerwear gap",
        items: [dress!, trainers!],
        gaps: [gap("outerwear")],
      },
      {
        name: "Bottom and shoes gaps",
        items: [tshirt!],
        gaps: [gap("bottom"), gap("shoes")],
      },
      {
        name: "Dress and outerwear gaps",
        items: [trainers!],
        gaps: [gap("dress_jumpsuit"), gap("outerwear")],
      },
      {
        name: "Three gaps",
        items: [tshirt!],
        gaps: [gap("bottom"), gap("shoes"), gap("outerwear")],
      },
      {
        name: "Three gaps around a coat",
        items: [blazer!],
        gaps: [gap("top"), gap("bottom"), gap("shoes")],
      },
    ];
    // A response holds at most 5 outfits, so ask twice.
    for (const batch of [cases.slice(0, 5), cases.slice(5)]) {
      await page.unroute("**/api/outfits");
      await answerOutfits(
        page,
        batch.map((c) => outfit(c.name, c.items, c.gaps)),
        ["shoes"],
      );
      await askForCasual(page);
      await expect(cards(page)).toHaveCount(batch.length);
      for (const [i, c] of batch.entries()) {
        const card = cards(page).nth(i);
        const collage = card.getByTestId("outfit-collage");
        await expect(collage).toHaveAttribute(
          "data-gaps",
          String(c.gaps.length),
        );
        await expectCollageReadyAndExportable(card);
        await expect(card.getByTestId("gap-row")).toHaveCount(c.gaps.length);
        for (const g of c.gaps) {
          await expect(
            card.locator(
              `[data-testid="gap-row"][data-category="${g.category}"]`,
            ),
          ).toContainText(g.description);
          await expect(collage).toHaveAttribute(
            "aria-label",
            new RegExp(`suggested ${g.description} \\(not in your wardrobe\\)`),
          );
        }
        // A gap row offers no Swap (only owned items can be swapped).
        await expect(
          card.getByTestId("gap-row").getByRole("button", { name: /Swap/ }),
        ).toHaveCount(0);
        await expect(card.getByRole("button", { name: /^Swap / })).toHaveCount(
          c.items.length,
        );
      }
      await expectFitsPhone(page, cards(page));
      await expectFitsPhone(page, cards(page));
    }
    await expectSaveImageDownloads(page, cards(page).nth(2));
  });

  test("long and non-ASCII descriptions and product names fit the phone and still save", async ({
    page,
  }) => {
    const [tshirt, jeans] = await getItems(page, [ID.tshirt, ID.jeans]);
    const longDescription =
      "Chunky white leather trainers with a gum sole and contrast stitching, padded collar and a tonal lace-up front".slice(
        0,
        120,
      );
    const unbroken =
      "Superextralongunbrokenproductdescriptionwithoutanyspacesatallsoitcannotwrapnormally".slice(
        0,
        120,
      );
    const longTitle =
      "Nike Air Force 1 '07 Men's Trainers in White with Gum Sole "
        .repeat(3)
        .trim()
        .slice(0, 200);
    const product: Product = {
      shopId: "next",
      title: longTitle,
      url: "https://www.next.co.uk/style/st123",
      priceText: "£35",
      imageUrl: "/mock/upload.svg",
    };
    await answerOutfits(page, [
      outfit(
        "Long words",
        [tshirt!, jeans!],
        [
          gap("shoes", {
            description: longDescription,
            shopResults: [product],
            searchedAt: "2026-10-31T10:00:00.000Z",
            shopProduct: product,
          }),
        ],
      ),
      outfit(
        "Été à Paris · 週末",
        [tshirt!],
        [
          gap("bottom", { description: "Jupe plissée en lin, très légère 🌿" }),
          gap("shoes", { description: "厚底スニーカー ホワイト" }),
        ],
      ),
      outfit(
        "Unbroken",
        [tshirt!, jeans!],
        [gap("shoes", { description: unbroken })],
      ),
    ]);
    await askForCasual(page);
    await expect(cards(page)).toHaveCount(3);
    for (const i of [0, 1, 2])
      await expectCollageReadyAndExportable(cards(page).nth(i));
    await expect(
      cards(page).nth(1).getByTestId("gap-row").first(),
    ).toContainText("Jupe plissée en lin, très légère 🌿");
    await expect(cards(page).nth(1)).toContainText("厚底スニーカー ホワイト");
    await expectSaveImageDownloads(page, cards(page).nth(1));
    await expectSaveImageDownloads(page, cards(page).nth(0));
    await expectFitsPhone(page, cards(page));
  });
});

// ---------------------------------------------------------------------------
// Notices
// ---------------------------------------------------------------------------

test.describe("notices", () => {
  test("missing categories: several categories in words, and none when the list is empty", async ({
    page,
  }) => {
    const [tshirt] = await getItems(page, [ID.tshirt]);
    await answerOutfits(
      page,
      [outfit("Top only", [tshirt!], [gap("bottom"), gap("shoes")])],
      ["bottom", "shoes"],
    );
    await askForCasual(page);
    const notice = page.getByTestId("missing-categories");
    await expect(notice).toHaveText(
      /Add trousers or skirts and shoes to your wardrobe to complete these outfits\./,
    );
    await expect(notice).toContainText(
      "The dashed pieces are suggestions for now.",
    );
    expect(
      (await notice.getByRole("link", { name: "Add clothes" }).boundingBox())!
        .height,
    ).toBeGreaterThanOrEqual(44);
    await expectFitsPhone(page, notice);
  });

  test("the empty_wardrobe notice replaces results, and Change request goes back to the form", async ({
    page,
  }) => {
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
    await tapRadio(page, "Casual");
    await page
      .getByRole("switch", { name: "Include items from my shops" })
      .check();
    await page.getByRole("button", { name: "Get outfits" }).click();
    const notice = page.getByTestId("incomplete-wardrobe");
    await expect(notice).toHaveAttribute("data-reason", "empty_wardrobe");
    await expect(cards(page)).toHaveCount(0);
    await expect(page.getByTestId("missing-categories")).toHaveCount(0);
    for (const name of ["Get started", "Add clothes"]) {
      expect(
        (await notice.getByRole("link", { name }).boundingBox())!.height,
      ).toBeGreaterThanOrEqual(44);
    }
    await expectFitsPhone(page, notice);
    await page.getByRole("button", { name: "Change request" }).click();
    await expect(
      page.getByRole("switch", { name: "Include items from my shops" }),
    ).toBeChecked();
  });
});

// ---------------------------------------------------------------------------
// The shop toggle through refine
// ---------------------------------------------------------------------------

test.describe("Include items from my shops through refine", () => {
  test("on: the flag goes with the request, the refined set keeps it, and the form remembers it", async ({
    page,
  }) => {
    const body = await askForCasual(page, { shopItems: true });
    expect(body.includeShopItems).toBe(true);
    const card = cards(page).first();
    await expect(card.getByTestId("gap-row")).toHaveCount(1);

    await card.getByRole("button", { name: "Tweak this outfit" }).click();
    const refine = page.waitForResponse((r) =>
      /\/api\/outfits\/[^/]+\/refine$/.test(new URL(r.url()).pathname),
    );
    await card.getByRole("button", { name: "Warmer", exact: true }).click();
    const response = await refine;
    expect(response.status()).toBe(200);
    // The refine body is only the feedback; the server carries the parent's flag.
    expect(response.request().postDataJSON()).toEqual({
      kind: "guidance",
      text: "warmer",
    });
    const json = (await response.json()) as {
      status: string;
      outfits?: { request: { includeShopItems: boolean } }[];
    };
    expect(json.status).toBe("ok");
    for (const o of json.outfits ?? [])
      expect(o.request.includeShopItems).toBe(true);

    await page.getByRole("button", { name: "Change request" }).click();
    await expect(
      page.getByRole("switch", { name: "Include items from my shops" }),
    ).toBeChecked();
  });

  test("off: refine results carry includeShopItems false", async ({ page }) => {
    const body = await askForCasual(page);
    expect(body).not.toHaveProperty("includeShopItems");
    const card = cards(page).first();
    await card.getByRole("button", { name: "Tweak this outfit" }).click();
    const refine = page.waitForResponse((r) =>
      /\/refine$/.test(new URL(r.url()).pathname),
    );
    await card.getByRole("button", { name: "Smarter", exact: true }).click();
    const json = (await (await refine).json()) as {
      outfits?: { request: { includeShopItems: boolean } }[];
    };
    for (const o of json.outfits ?? [])
      expect(o.request.includeShopItems).toBe(false);
    await expect(page.getByText("With items from your shops")).toHaveCount(0);
  });

  test("toggling on then off before asking sends no flag", async ({ page }) => {
    await page.goto("/outfits");
    await tapRadio(page, "Casual");
    const toggle = page.getByRole("switch", {
      name: "Include items from my shops",
    });
    await toggle.check();
    await toggle.uncheck();
    const sent = page.waitForRequest(
      (r) =>
        r.method() === "POST" && new URL(r.url()).pathname === "/api/outfits",
    );
    await page.getByRole("button", { name: "Get outfits" }).click();
    expect((await sent).postDataJSON()).not.toHaveProperty("includeShopItems");
  });
});

// ---------------------------------------------------------------------------
// Find in my shops: errors, no results, hostile data, picking
// ---------------------------------------------------------------------------

/** A shop-search answer: the outfit with these results on its shoes gap. */
async function answerShopSearch(
  page: Page,
  base: ReturnType<typeof outfit>,
  results: unknown[],
  status = 200,
) {
  await page.route(`**/api/outfits/${base.id}/shop-search`, (route) =>
    route.fulfill({
      status,
      json: {
        outfit: {
          ...base,
          gaps: base.gaps.map((g) => ({
            ...g,
            shopResults: results,
            searchedAt: "2026-10-31T11:00:00.000Z",
          })),
        },
      },
    }),
  );
}

test.describe("Find in my shops, adversarial", () => {
  test("the button only shows on outfits with gaps", async ({ page }) => {
    const [tshirt, jeans, trainers] = await getItems(page, [
      ID.tshirt,
      ID.jeans,
      ID.trainers,
    ]);
    await answerOutfits(page, [
      outfit("Complete", [tshirt!, jeans!, trainers!], []),
      outfit("With gap", [tshirt!, jeans!], [gap("shoes")]),
    ]);
    await askForCasual(page);
    await expect(cards(page).nth(0).getByTestId("shop-finder")).toHaveCount(0);
    await expect(
      cards(page).nth(1).getByRole("button", { name: "Find in my shops" }),
    ).toBeVisible();
  });

  test("a gap with no results says so and links to choosing more shops; another gap's results still show", async ({
    page,
  }) => {
    const [tshirt] = await getItems(page, [ID.tshirt]);
    const base = outfit(
      "Two gaps",
      [tshirt!],
      [
        gap("bottom", { description: "Navy chinos" }),
        gap("shoes", { description: "White trainers" }),
      ],
    );
    await answerOutfits(page, [base]);
    const product: Product = {
      shopId: "next",
      title: "Navy chinos",
      url: "https://www.next.co.uk/style/c1",
      priceText: "£30",
      imageUrl: null,
    };
    await page.route(`**/api/outfits/${base.id}/shop-search`, (route) =>
      route.fulfill({
        json: {
          outfit: {
            ...base,
            gaps: [
              {
                ...base.gaps[0]!,
                shopResults: [product],
                searchedAt: "2026-10-31T11:00:00.000Z",
              },
              {
                ...base.gaps[1]!,
                shopResults: [],
                searchedAt: "2026-10-31T11:00:00.000Z",
              },
            ],
          },
        },
      }),
    );
    await askForCasual(page);
    const card = cards(page).first();
    await card.getByRole("button", { name: "Find in my shops" }).click();
    const empty = card.locator(
      '[data-testid="shop-results"][data-category="shoes"]',
    );
    await expect(empty).toContainText(
      "Nothing found in your shops for this one.",
    );
    await expect(
      empty.getByRole("link", { name: "Choose more shops" }),
    ).toHaveAttribute("href", "/settings");
    await expect(
      card
        .locator('[data-testid="shop-results"][data-category="bottom"]')
        .getByTestId("product-card"),
    ).toHaveCount(1);
    await expect(
      card.getByRole("button", { name: "Search my shops again" }),
    ).toBeVisible();
    await expectFitsPhone(page, card);
  });

  test("the cap error, then Try again isn't offered; ai_failed offers Try again and a retry can succeed", async ({
    page,
  }) => {
    const [tshirt, jeans] = await getItems(page, [ID.tshirt, ID.jeans]);
    const base = outfit("Gap", [tshirt!, jeans!], [gap("shoes")]);
    await answerOutfits(page, [base]);
    let calls = 0;
    await page.route(`**/api/outfits/${base.id}/shop-search`, (route) => {
      calls++;
      if (calls === 1) {
        return route.fulfill({
          status: 429,
          json: {
            error: {
              code: "daily_cap_reached",
              message: "Limit",
              cap: {
                kind: "shop_searches_per_day",
                limit: 10,
                resetsAt: "2026-11-03T00:00:00.000Z",
              },
            },
          },
        });
      }
      if (calls === 2)
        return route.fulfill({
          status: 502,
          json: { error: { code: "ai_failed", message: "Model failed" } },
        });
      return route.fulfill({
        json: {
          outfit: {
            ...base,
            gaps: [
              {
                ...base.gaps[0]!,
                searchedAt: "2026-10-31T11:00:00.000Z",
                shopResults: [
                  {
                    shopId: "next",
                    title: "Trainers",
                    url: "https://www.next.co.uk/x",
                    priceText: null,
                    imageUrl: null,
                  },
                ],
              },
            ],
          },
        },
      });
    });
    await askForCasual(page);
    const card = cards(page).first();
    await card.getByRole("button", { name: "Find in my shops" }).click();
    const notice = card.getByTestId("api-error");
    await expect(notice).toHaveAttribute("data-code", "daily_cap_reached");
    await expect(notice.getByRole("button", { name: "Try again" })).toHaveCount(
      0,
    );
    // The outfits-only "See saved outfits" link isn't shown for shop search.
    await expect(
      notice.getByRole("link", { name: "See saved outfits" }),
    ).toHaveCount(0);
    // The collage and the rest of the outfit still work.
    await expectCollageReadyAndExportable(card);

    await card.getByRole("button", { name: "Find in my shops" }).click();
    await expect(notice).toHaveAttribute("data-code", "ai_failed");
    await expect(notice).toContainText("We couldn't search your shops");
    await notice.getByRole("button", { name: "Try again" }).click();
    await expect(card.getByTestId("api-error")).toHaveCount(0);
    await expect(card.getByTestId("product-card")).toHaveCount(1);
    expect(calls).toBe(3);
  });

  test("ai_paused shows its own notice and the outfit's other actions still work", async ({
    page,
  }) => {
    const [tshirt, jeans] = await getItems(page, [ID.tshirt, ID.jeans]);
    const base = outfit("Paused", [tshirt!, jeans!], [gap("shoes")]);
    await answerOutfits(page, [base]);
    await page.route(`**/api/outfits/${base.id}/shop-search`, (route) =>
      route.fulfill({
        status: 503,
        json: { error: { code: "ai_paused", message: "Paused" } },
      }),
    );
    await askForCasual(page);
    const card = cards(page).first();
    await card.getByRole("button", { name: "Find in my shops" }).click();
    await expect(card.getByTestId("api-error")).toContainText(
      "Shop search is paused for now",
    );
    await expect(card.getByTestId("api-error")).toContainText(
      "until next month",
    );
    await expectSaveImageDownloads(page, card);
  });

  test("hostile links from the API (javascript:, data:, other sites) never become links on the page", async ({
    page,
  }) => {
    const [tshirt, jeans] = await getItems(page, [ID.tshirt, ID.jeans]);
    const base = outfit("Hostile", [tshirt!, jeans!], [gap("shoes")]);
    await answerOutfits(page, [base]);
    await answerShopSearch(page, base, [
      {
        shopId: "next",
        title: "Click me",
        url: "javascript:alert(document.cookie)",
        priceText: "£1",
        imageUrl: null,
      },
      {
        shopId: "next",
        title: "Data",
        url: "data:text/html,<script>alert(1)</script>",
        priceText: "£1",
        imageUrl: "javascript:alert(1)",
      },
      {
        shopId: "next",
        title: "Look-alike",
        url: "https://www.next.co.uk.evil.example/p",
        priceText: "£1",
        imageUrl: null,
      },
    ]);
    const dialogs: string[] = [];
    page.on("dialog", (d) => {
      dialogs.push(d.message());
      void d.dismiss();
    });
    await askForCasual(page);
    const card = cards(page).first();
    await card.getByRole("button", { name: "Find in my shops" }).click();
    await expect(card.getByTestId("api-error")).toHaveAttribute(
      "data-code",
      "internal",
    );
    await expect(card.getByTestId("product-card")).toHaveCount(0);
    const hrefs = await page
      .locator("a[href]")
      .evaluateAll((as) => as.map((a) => a.getAttribute("href")!));
    for (const href of hrefs)
      expect(href).not.toMatch(
        /^\s*(javascript|data|vbscript):|evil\.example/i,
      );
    expect(dialogs).toEqual([]);
  });

  test("very long titles, broken images and missing prices: cards fit the phone, images fall back, links are safe", async ({
    page,
  }) => {
    const [tshirt, jeans] = await getItems(page, [ID.tshirt, ID.jeans]);
    const base = outfit("Messy shop data", [tshirt!, jeans!], [gap("shoes")]);
    const longTitle = "Trainers ".repeat(30).trim().slice(0, 200);
    const unbroken = "T".repeat(200);
    const results: Product[] = [
      {
        shopId: "next",
        title: longTitle,
        url: "https://www.next.co.uk/style/a1",
        priceText: "£29.50 - £35.00 (was £45.00)",
        imageUrl: "https://xcdn.next.co.uk/broken.jpg",
      },
      {
        shopId: "marks_and_spencer",
        title: unbroken,
        url: "https://www.marksandspencer.com/p/b2",
        priceText: null,
        imageUrl: "/does-not-exist.png",
      },
      {
        shopId: "new_look",
        title: '<img src=x onerror=alert(1)> & "quotes"',
        url: "https://www.newlook.com/uk/p/c3",
        priceText: "£20",
        imageUrl: null,
      },
    ];
    await answerOutfits(page, [base]);
    await answerShopSearch(page, base, results);
    // Broken images: answer every product image with a 404.
    const imageRequests: { url: string; referer: string | undefined }[] = [];
    await page.route("https://xcdn.next.co.uk/**", (route) => {
      imageRequests.push({
        url: route.request().url(),
        referer: route.request().headers()["referer"],
      });
      return route.fulfill({ status: 404, body: "" });
    });
    let picked: Product | null = null;
    await page.route(`**/api/outfits/${base.id}/gaps/shoes`, (route) => {
      const { productUrl } = route.request().postDataJSON() as {
        productUrl: string | null;
      };
      picked = productUrl ? results.find((r) => r.url === productUrl)! : null;
      return route.fulfill({
        json: {
          outfit: {
            ...base,
            gaps: [
              {
                ...base.gaps[0]!,
                shopResults: results,
                searchedAt: "2026-10-31T11:00:00.000Z",
                shopProduct: picked,
              },
            ],
          },
        },
      });
    });

    await askForCasual(page);
    const card = cards(page).first();
    await card.getByRole("button", { name: "Find in my shops" }).click();
    const products = card.getByTestId("product-card");
    await expect(products).toHaveCount(3);

    // Images use no-referrer, and broken ones become the icon.
    await expect.poll(() => imageRequests.length).toBeGreaterThan(0);
    expect(imageRequests.every((r) => r.referer === undefined)).toBe(true);
    await expect(products.locator("img")).toHaveCount(0);

    // Markup is text, not HTML.
    await expect(products.nth(2)).toContainText(
      '<img src=x onerror=alert(1)> & "quotes"',
    );
    // Every shop link opens a new tab with noopener and no referrer, on the shop's own site.
    const links = card.getByRole("link", { name: /^View in / });
    await expect(links).toHaveCount(3);
    for (let i = 0; i < 3; i++) {
      await expect(links.nth(i)).toHaveAttribute("target", "_blank");
      const rel = (await links.nth(i).getAttribute("rel"))!.split(/\s+/);
      expect(rel).toEqual(expect.arrayContaining(["noopener", "noreferrer"]));
      expect(await links.nth(i).getAttribute("href")).toBe(results[i]!.url);
    }
    await expectFitsPhone(page, card);

    // Pick the long (spaced) title: the "Your pick" row fits, and the collage still saves.
    await products.nth(0).getByRole("button", { name: "Pick this" }).click();
    await expect(card.getByTestId("chosen-product")).toBeVisible();
    await expectCollageReadyAndExportable(card);
    await expectFitsPhone(page, card);
  });

  // Was a BUG (fixed): the "Your pick" title had no break-words, so a title
  // with no spaces made the whole page scroll sideways at 390 px.
  test("a picked product with a long unbroken title doesn't make the page scroll sideways", async ({ page }) => {
    const [tshirt, jeans] = await getItems(page, [ID.tshirt, ID.jeans]);
    const product: Product = {
      shopId: "marks_and_spencer",
      title: "T".repeat(200),
      url: "https://www.marksandspencer.com/p/b2",
      priceText: null,
      imageUrl: null,
    };
    await answerOutfits(page, [
      outfit("Unbroken pick", [tshirt!, jeans!], [
        gap("shoes", { shopResults: [product], searchedAt: "2026-10-31T10:00:00.000Z", shopProduct: product }),
      ]),
    ]);
    await askForCasual(page);
    const card = cards(page).first();
    await expect(card.getByTestId("chosen-product")).toBeVisible();
    await expectFitsPhone(page, card);
  });

  test("picking, switching and clearing a product; a failed pick shows an error and changes nothing", async ({
    page,
  }) => {
    await askForCasual(page, { shopItems: true });
    const card = cards(page).first();
    await card.getByRole("button", { name: "Find in my shops" }).click();
    const products = card.getByTestId("product-card");
    await expect(products).toHaveCount(3);
    const collage = card.getByTestId("outfit-collage");

    await products.nth(0).getByRole("button", { name: "Pick this" }).click();
    await expect(products.nth(0)).toHaveAttribute("data-chosen", "true");
    // Switch straight to another: only one is picked.
    await products.nth(2).getByRole("button", { name: "Pick this" }).click();
    await expect(products.nth(2)).toHaveAttribute("data-chosen", "true");
    await expect(products.nth(0)).toHaveAttribute("data-chosen", "false");
    await expect(card.getByTestId("chosen-product")).toHaveCount(1);
    const title = (await products.nth(2).locator("p").first().textContent())!;
    await expect(card.getByTestId("chosen-product")).toContainText(title);
    await expect(collage).toHaveAttribute(
      "aria-label",
      new RegExp(`suggested ${title.replace(/[()]/g, "\\$&")}`),
    );
    await expectCollageReadyAndExportable(card);

    // Un-pick by tapping "Unpick" on the card itself.
    await products.nth(2).getByRole("button", { name: /^Unpick/ }).click();
    await expect(card.getByTestId("chosen-product")).toHaveCount(0);

    // A failed pick: error shown, nothing marked as picked.
    await page.route("**/api/outfits/*/gaps/shoes", (route) =>
      route.fulfill({
        status: 400,
        json: {
          error: {
            code: "bad_request",
            message: "That isn't one of this gap's results",
          },
        },
      }),
    );
    await products.nth(1).getByRole("button", { name: "Pick this" }).click();
    await expect(card.getByTestId("api-error")).toBeVisible();
    await expect(products.nth(1)).toHaveAttribute("data-chosen", "false");
    await expect(card.getByTestId("chosen-product")).toHaveCount(0);
  });

  test("I've bought this pre-fills add-by-link with a product URL that has its own query string", async ({
    page,
  }) => {
    const [tshirt, jeans] = await getItems(page, [ID.tshirt, ID.jeans]);
    const productUrl =
      "https://www.next.co.uk/style/st123?colour=white&size=8#reviews";
    const product: Product = {
      shopId: "next",
      title: "Trainers",
      url: productUrl,
      priceText: "£35",
      imageUrl: null,
    };
    await answerOutfits(page, [
      outfit(
        "Bought",
        [tshirt!, jeans!],
        [
          gap("shoes", {
            shopResults: [product],
            searchedAt: "2026-10-31T10:00:00.000Z",
            shopProduct: product,
          }),
        ],
      ),
    ]);
    await askForCasual(page);
    await cards(page)
      .first()
      .getByTestId("chosen-product")
      .getByRole("link", { name: /^I've bought this/ })
      .click();
    await expect(page).toHaveURL(/\/add\/link\?url=/);
    expect(new URL(page.url()).searchParams.get("url")).toBe(productUrl);
    await expect
      .poll(() =>
        page.evaluate(() =>
          [...document.querySelectorAll("input, textarea")].map(
            (el) => (el as HTMLInputElement).value,
          ),
        ),
      )
      .toContain(productUrl);
  });
});

// ---------------------------------------------------------------------------
// Saved outfits with gaps
// ---------------------------------------------------------------------------

test.describe("saved outfits with gaps", () => {
  test("several gaps and a pick show on the saved screen, without a sideways scroll", async ({
    page,
  }) => {
    const [tshirt] = await getItems(page, [ID.tshirt]);
    const product: Product = {
      shopId: "next",
      title: "Navy chinos",
      url: "https://www.next.co.uk/style/c1",
      priceText: "£30",
      imageUrl: null,
    };
    const saved = outfit(
      "Saved with gaps",
      [tshirt!],
      [
        gap("bottom", {
          shopResults: [product],
          searchedAt: "2026-10-31T10:00:00.000Z",
          shopProduct: product,
        }),
        gap("shoes"),
        gap("outerwear"),
      ],
      {
        status: "saved",
      },
    );
    // The saved screen lists saved and liked outfits: this one is only in the saved list.
    await page.route("**/api/outfits?*", (route) =>
      route.request().method() === "GET"
        ? route.fulfill({
            json: {
              outfits:
                new URL(route.request().url()).searchParams.get("status") ===
                "saved"
                  ? [saved]
                  : [],
            },
          })
        : route.fallback(),
    );
    await page.goto("/outfits/saved");
    const card = page.locator(
      `[data-testid="outfit-card"][data-outfit-id="${saved.id}"]`,
    );
    await expect(card).toBeVisible();
    await expect(card.getByTestId("gap-row")).toHaveCount(3);
    await expect(card.getByTestId("outfit-collage")).toHaveAttribute(
      "data-gaps",
      "3",
    );
    await expect(card.getByTestId("chosen-product")).toContainText(
      "Navy chinos",
    );
    await expect(
      card.getByTestId("chosen-product").getByRole("link", { name: /^I've bought this/ }),
    ).toHaveAttribute(
      "href",
      `/add/link?url=${encodeURIComponent(product.url)}`,
    );
    await expectCollageReadyAndExportable(card);
    await expectFitsPhone(page, card);
  });
});

// ---------------------------------------------------------------------------
// Cut-out queue in the browser
// ---------------------------------------------------------------------------

async function optInToCutouts(page: Page, fakeRemover = true) {
  if (fakeRemover) await installFakeBackgroundRemover(page);
  await page.addInitScript(() => {
    (
      window as unknown as { __GLADRAGS_TEST_COLLAGE_CUTOUTS__?: boolean }
    ).__GLADRAGS_TEST_COLLAGE_CUTOUTS__ = true;
  });
}

/** Two outfits sharing the coat and the blazer, neither of which has a cut-out in this answer. */
async function answerWithUncutItems(
  page: Page,
  extra: Record<string, Partial<Item>> = {},
) {
  const [shirt, jeans, trainers, coat, blazer, tshirt] = await getItems(page, [
    ID.shirt,
    ID.jeans,
    ID.trainers,
    ID.coat,
    ID.blazer,
    ID.tshirt,
  ]);
  const uncut = (item: Item): Item => ({
    ...item,
    cutoutUrl: null,
    needsPhoto: false,
    ...extra[item.id],
  });
  const c = uncut(coat!);
  const b = uncut(blazer!);
  await answerOutfits(page, [
    outfit("Coat look", [shirt!, jeans!, trainers!, c], []),
    outfit("Blazer look", [tshirt!, jeans!, b], [gap("shoes")]),
    outfit("Coat again", [tshirt!, jeans!, c], [gap("shoes")]),
  ]);
  return { coat: c, blazer: b };
}

/** Count requests for one item's cut-out upload and for its original as a fetch (the queue's download). */
async function watchItem(
  page: Page,
  itemId: string,
  originalUrl: string,
  options: {
    uploadStatus?: number;
    hold?: Promise<void>;
    failOriginal?: boolean;
  } = {},
) {
  const seen = { uploads: 0, originalFetches: 0 };
  await page.route(`**/api/items/${itemId}/cutout`, async (route: Route) => {
    seen.uploads++;
    if (options.hold) await options.hold;
    if ((options.uploadStatus ?? 200) !== 200) {
      return route.fulfill({
        status: options.uploadStatus,
        json: { error: { code: "internal", message: "Upload failed" } },
      });
    }
    return route.fulfill({
      status: 500,
      json: {
        error: { code: "internal", message: "QA: uploads are not stored" },
      },
    });
  });
  await page.route(
    `**${new URL(originalUrl, "http://x").pathname}*`,
    (route) => {
      if (route.request().resourceType() === "fetch") {
        seen.originalFetches++;
        if (options.failOriginal)
          return route.fulfill({ status: 403, body: "expired" });
      }
      return route.fallback();
    },
  );
  return seen;
}

test.describe("cut-out queue in the browser", () => {
  test("one item at a time across collages: the second item isn't downloaded until the first one's upload finishes; each once", async ({
    page,
  }) => {
    await optInToCutouts(page);
    const { coat, blazer } = await answerWithUncutItems(page);
    // Collages draw side by side, so either item may be first in the queue.
    // Both uploads are held; whichever starts first must hold up the other.
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const coatSeen = await watchItem(
      page,
      coat.id,
      coat.originalUrl as string,
      { hold },
    );
    const blazerSeen = await watchItem(
      page,
      blazer.id,
      blazer.originalUrl as string,
      { hold },
    );

    await askForCasual(page);
    await expect(cards(page)).toHaveCount(3);
    for (const i of [0, 1, 2])
      await expectCollageReadyAndExportable(cards(page).nth(i));
    await expect.poll(() => coatSeen.uploads + blazerSeen.uploads).toBe(1);
    await page.waitForTimeout(500);
    // The first job holds the line: nothing else has started.
    const [first, second] =
      coatSeen.uploads === 1 ? [coatSeen, blazerSeen] : [blazerSeen, coatSeen];
    expect(first.originalFetches).toBe(1);
    expect(second.originalFetches).toBe(0);
    expect(second.uploads).toBe(0);
    release();
    await expect.poll(() => second.uploads).toBe(1);
    await page.waitForTimeout(300);
    expect(coatSeen.originalFetches).toBe(1);
    expect(coatSeen.uploads).toBe(1);
    expect(blazerSeen.originalFetches).toBe(1);
    expect(blazerSeen.uploads).toBe(1);
    // No error notices from failed uploads.
    await expect(page.getByTestId("api-error")).toHaveCount(0);
  });

  test("removal failing (the model won't load): collages keep the originals, can be saved, and nothing is uploaded", async ({
    page,
  }) => {
    // The real remover, with its model download refused.
    await optInToCutouts(page, false);
    await page.route("**/models/**", (route) =>
      route.fulfill({ status: 404, body: "" }),
    );
    const { coat, blazer } = await answerWithUncutItems(page);
    const coatSeen = await watchItem(page, coat.id, coat.originalUrl as string);
    const blazerSeen = await watchItem(
      page,
      blazer.id,
      blazer.originalUrl as string,
    );
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));

    await askForCasual(page);
    for (const i of [0, 1, 2])
      await expectCollageReadyAndExportable(cards(page).nth(i));
    await page.waitForTimeout(1_500);
    expect(coatSeen.uploads + blazerSeen.uploads).toBe(0);
    for (const i of [0, 1, 2])
      await expect(
        cards(page).nth(i).getByTestId("outfit-collage"),
      ).toHaveAttribute("data-cutouts", "0");
    await expectSaveImageDownloads(page, cards(page).nth(1));
    expect(errors).toEqual([]);
  });

  test("upload failing: the collage is unaffected and the item isn't uploaded again, even on a new request", async ({
    page,
  }) => {
    await optInToCutouts(page);
    const { coat } = await answerWithUncutItems(page);
    const coatSeen = await watchItem(
      page,
      coat.id,
      coat.originalUrl as string,
      { uploadStatus: 503 },
    );
    await askForCasual(page);
    for (const i of [0, 1, 2])
      await expectCollageReadyAndExportable(cards(page).nth(i));
    await expect.poll(() => coatSeen.uploads).toBe(1);
    await page.getByRole("button", { name: "Change request" }).click();
    await page.getByRole("button", { name: "Get outfits" }).click();
    for (const i of [0, 1, 2])
      await expectCollageReadyAndExportable(cards(page).nth(i));
    await page.waitForTimeout(500);
    expect(coatSeen.uploads).toBe(1);
    await expect(page.getByTestId("api-error")).toHaveCount(0);
  });

  test("the original failing to download: no upload, the collage still draws, and a later request tries again", async ({
    page,
  }) => {
    await optInToCutouts(page);
    const { coat } = await answerWithUncutItems(page);
    const coatSeen = await watchItem(
      page,
      coat.id,
      coat.originalUrl as string,
      { failOriginal: true },
    );
    await askForCasual(page);
    for (const i of [0, 1, 2])
      await expectCollageReadyAndExportable(cards(page).nth(i));
    await expect.poll(() => coatSeen.originalFetches).toBeGreaterThanOrEqual(1);
    await page.waitForTimeout(300);
    expect(coatSeen.uploads).toBe(0);
    const first = coatSeen.originalFetches;
    // Two collages show the coat, but they share one attempt at a time; not a burst per collage redraw.
    expect(first).toBeLessThanOrEqual(2);

    await page.getByRole("button", { name: "Change request" }).click();
    await page.getByRole("button", { name: "Get outfits" }).click();
    for (const i of [0, 1, 2])
      await expectCollageReadyAndExportable(cards(page).nth(i));
    await expect.poll(() => coatSeen.originalFetches).toBeGreaterThan(first);
    expect(coatSeen.uploads).toBe(0);
  });

  test("needsPhoto items are never downloaded for a cut-out or uploaded, even next to items that are", async ({
    page,
  }) => {
    await optInToCutouts(page);
    const { coat, blazer } = await answerWithUncutItems(page, {
      [ID.coat]: { needsPhoto: true },
    });
    const coatSeen = await watchItem(page, coat.id, coat.originalUrl as string);
    const blazerSeen = await watchItem(
      page,
      blazer.id,
      blazer.originalUrl as string,
    );
    await askForCasual(page);
    for (const i of [0, 1, 2])
      await expectCollageReadyAndExportable(cards(page).nth(i));
    await expect.poll(() => blazerSeen.uploads).toBe(1);
    await page.waitForTimeout(500);
    expect(coatSeen.originalFetches).toBe(0);
    expect(coatSeen.uploads).toBe(0);
  });

  test("without the opt-in nothing is cut out, even with the fake remover", async ({
    page,
  }) => {
    await installFakeBackgroundRemover(page);
    const { coat, blazer } = await answerWithUncutItems(page);
    const coatSeen = await watchItem(page, coat.id, coat.originalUrl as string);
    const blazerSeen = await watchItem(
      page,
      blazer.id,
      blazer.originalUrl as string,
    );
    await askForCasual(page);
    for (const i of [0, 1, 2])
      await expectCollageReadyAndExportable(cards(page).nth(i));
    await page.waitForTimeout(500);
    expect(
      coatSeen.originalFetches +
        blazerSeen.originalFetches +
        coatSeen.uploads +
        blazerSeen.uploads,
    ).toBe(0);
  });
});
