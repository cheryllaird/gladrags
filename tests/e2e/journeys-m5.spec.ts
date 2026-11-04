import { readFileSync } from "node:fs";
import { expect, test, type Locator, type Page, type Request, type Response, type Route } from "@playwright/test";
import {
  BatchAddResponseSchema,
  ItemResponseSchema,
  ItemListResponseSchema,
  OutfitGenerationResponseSchema,
  OutfitResponseSchema,
  type Outfit,
  type WardrobeItem,
} from "@/contracts";
import { installFakeBackgroundRemover } from "./helpers";
import { checkPhoneLayout } from "./phone-layout";

// The spec's five core journeys as they stand after Cheryl's test
// (docs/SPEC.md, "Users and core journeys" and "Changes from Cheryl's
// test"), end to end on a 390 px phone against mock mode (CONTRACTS.md
// section 1): a get-started checklist, adding without background removal,
// several photos and links at once with a review list, order emails,
// outfits with gaps, "Find in my shops", and cut-outs made the first time a
// collage needs an item.
//
// journeys.spec.ts keeps the original single-item journeys, the missing
// category notice and account deletion.
//
// The mock store is shared by every spec on the server (one process, one
// mock user), so these tests:
// - only add items, never delete them, and pick out their own items by the
//   IDs the server gave back, never by a list's length;
// - narrow a list to their own items only where another test's items would
//   make the screen unpredictable (the review list), by filtering the real
//   server's answer, never by making one up;
// - put back what they change in shared settings (favourite shops) and
//   outfit statuses;
// - answer GET /api/items and GET /api/outfits with empty lists only for
//   the new-user checklist, the one state a shared, stocked store can't
//   reach.

const PHOTO = readFileSync(new URL("./fixtures/shirt.jpg", import.meta.url));
// A recorded order email (an M&S-style confirmation forwarded from a phone),
// shared with the email import unit tests.
const ORDER_EMAIL_HTML = readFileSync(new URL("../../src/lib/email/fixtures/ms-order.html", import.meta.url), "utf8");
const MOCK_EMAIL = "mock.user@gladrags.test";
const SUGGESTED = "Navy and white striped linen shirt";
const RED_PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

const photo = (name: string) => ({ name, mimeType: "image/jpeg", buffer: PHOTO });

function unique(label: string): string {
  return `${label} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

const nav = (page: Page) => page.getByRole("navigation", { name: "Main" });
const outfitCards = (page: Page) => page.getByTestId("outfit-card");
const card = (page: Page, id: string) => page.locator(`[data-testid="outfit-card"][data-outfit-id="${id}"]`);
const path = (url: string) => new URL(url).pathname;

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

function isItemsList(url: URL, needsReview: boolean | null): boolean {
  if (url.pathname !== "/api/items") return false;
  const value = url.searchParams.get("needsReview");
  return needsReview === null ? value === null : value === String(needsReview);
}

/** Whether a multipart upload carries a file or field of this name. */
function hasPart(request: Request, name: string): boolean {
  return (request.postDataBuffer()?.toString("latin1") ?? "").includes(`name="${name}"`);
}

/** Watches for the background-removal model or its runtime being fetched. */
function watchModelDownloads(page: Page): string[] {
  const fetched: string[] = [];
  page.on("request", (request) => {
    const p = path(request.url());
    if (p.startsWith("/models/") || p.startsWith("/ort/") || p.endsWith(".onnx") || p.endsWith(".wasm")) fetched.push(p);
  });
  return fetched;
}

/** Records every batch add answer (photo or link step 2) and passes it on. */
async function recordBatchAdds(page: Page, pattern: string): Promise<{ items: WardrobeItem[]; requests: Request[] }> {
  const record = { items: [] as WardrobeItem[], requests: [] as Request[] };
  await page.route(pattern, async (route: Route) => {
    const response = await route.fetch();
    if (route.request().method() === "POST") {
      record.requests.push(route.request());
      if (response.ok()) {
        const parsed = BatchAddResponseSchema.safeParse(await response.json());
        if (parsed.success && parsed.data.status === "saved") record.items.push(parsed.data.item);
      }
    }
    await route.fulfill({ response });
  });
  return record;
}

/** The review list shows only these items (the real server's answer, filtered). */
async function narrowReviewListTo(page: Page, ids: () => readonly string[]) {
  await page.route(
    (url) => isItemsList(url, true),
    async (route) => {
      const response = await route.fetch();
      const { items } = ItemListResponseSchema.parse(await response.json());
      await route.fulfill({ response, json: { items: items.filter((item) => ids().includes(item.id)) } });
    },
  );
}

async function getItem(page: Page, id: string): Promise<WardrobeItem> {
  const res = await page.request.get(`/api/items/${id}`);
  expect(res.status()).toBe(200);
  return ItemResponseSchema.parse(await res.json()).item;
}

function outfitsResponse(page: Page, pattern: RegExp): Promise<Response> {
  return page.waitForResponse((res) => res.request().method() === "POST" && pattern.test(path(res.url())));
}

async function okOutfits(response: Response): Promise<{ outfits: Outfit[]; missingCategories: string[] }> {
  expect(response.status()).toBe(200);
  const parsed = OutfitGenerationResponseSchema.parse(await response.json());
  if (parsed.status !== "ok") throw new Error(`expected outfits, got ${parsed.status}: ${parsed.message}`);
  return { outfits: parsed.outfits, missingCategories: parsed.missingCategories };
}

/** Ask for outfits from the Outfits tab. */
async function askForOutfits(page: Page, options: { style: string; guidance?: string; shopItems?: boolean }) {
  await nav(page).getByRole("link", { name: "Outfits" }).click();
  await expect(page.getByRole("heading", { name: "Outfit ideas" })).toBeVisible();
  await tapRadio(page, options.style);
  if (options.guidance) await page.getByLabel("Anything else? (optional)").fill(options.guidance);
  if (options.shopItems) await page.getByRole("switch", { name: "Include items from my shops" }).check();
  const response = outfitsResponse(page, /^\/api\/outfits$/);
  await page.getByRole("button", { name: "Get outfits" }).click();
  const result = await okOutfits(await response);
  await expect(page.getByRole("heading", { level: 1, name: `Outfits for ${options.style}` })).toBeVisible();
  return { ...result, sent: (await response).request().postDataJSON() as Record<string, unknown> };
}

/** The collage is drawn and not tainted (it can still be saved as an image). */
async function expectCollageReady(outfitCard: Locator) {
  const canvas = outfitCard.getByTestId("outfit-collage");
  await canvas.scrollIntoViewIfNeeded();
  await expect(canvas).toHaveAttribute("data-state", "ready");
  const exported = await canvas.evaluate((el: HTMLCanvasElement) => el.toDataURL("image/png").length);
  expect(exported).toBeGreaterThan(5_000);
}

/** Each gap shows as a dashed placeholder in the collage and a row in the list. */
async function expectGapsShown(outfitCard: Locator, outfit: Outfit) {
  const collage = outfitCard.getByTestId("outfit-collage");
  await expect(collage).toHaveAttribute("data-gaps", String(outfit.gaps.length));
  const rows = outfitCard.getByTestId("gap-row");
  await expect(rows).toHaveCount(outfit.gaps.length);
  for (const gap of outfit.gaps) {
    await expect(outfitCard.locator(`[data-testid="gap-row"][data-category="${gap.category}"]`)).toContainText("not in your wardrobe");
    const label = gap.shopProduct?.title ?? gap.description;
    await expect(collage).toHaveAttribute("aria-label", new RegExp(`suggested ${escapeRegExp(label)}`, "i"));
  }
  await expectCollageReady(outfitCard);
}

async function postOrderEmail(page: Page, messageId: string) {
  const settings = await (await page.request.get("/api/settings")).json();
  const res = await page.request.post("/api/inbound/email", {
    data: {
      messageId,
      from: MOCK_EMAIL,
      to: [settings.forwardingAddress],
      subject: "Fwd: We've got your order",
      text: null,
      html: ORDER_EMAIL_HTML,
      receivedAt: "2026-10-30T10:00:00.000Z",
      auth: { spf: "pass", dkim: "pass", dmarc: "pass" },
      spam: { isSpam: false, score: 0 },
    },
  });
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ received: true });
}

async function toReviewIds(page: Page): Promise<string[]> {
  const res = await page.request.get("/api/items?needsReview=true");
  return ItemListResponseSchema.parse(await res.json()).items.map((i) => i.id);
}

// ---------------------------------------------------------------------------
// Journey 1: build the wardrobe
// ---------------------------------------------------------------------------

test.describe("journey 1: build the wardrobe", () => {
  test("a new user signs in to the get-started checklist and adds one photo, with no background removal", async ({ page }) => {
    const downloads = watchModelDownloads(page);
    // A new user's empty wardrobe (the shared mock store is stocked).
    const emptyWardrobe = (route: Route) => (route.request().method() === "GET" ? route.fulfill({ json: { items: [] } }) : route.fallback());
    const wardrobeList = (url: URL) => isItemsList(url, null) || isItemsList(url, false);
    await page.route(wardrobeList, emptyWardrobe);
    // ...and no outfits yet (other tests' outfits in the shared store would tick "Get your first outfit").
    const noOutfits = (route: Route) => (route.request().method() === "GET" ? route.fulfill({ json: { outfits: [] } }) : route.fallback());
    await page.route("**/api/outfits", noOutfits);

    await page.goto("/sign-in");
    await page.getByLabel("Email").fill("new.tester@example.com");
    await page.getByRole("button", { name: "Email me a sign-in link" }).click();
    await page.getByLabel("Code from the email").fill("123456");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/wardrobe$/);

    // The checklist instead of an empty grid, saying outfits work from the first item.
    await expect(page.getByRole("heading", { name: "Your wardrobe is empty" })).toBeVisible();
    await expect(page.getByText("0 of 4 done")).toBeVisible();
    await expect(page.getByText(/Outfits work from your first item/).first()).toBeVisible();
    await checkPhoneLayout(page, "get-started checklist");

    // First step: add one item, by photo. The add screens never fetch the model.
    await page.getByRole("link", { name: /Add your first item/ }).click();
    await expect(page.getByRole("heading", { name: "Add an item" })).toBeVisible();
    const upload = page.waitForResponse((res) => path(res.url()) === "/api/items/photo");
    await page.getByTestId("photo-library-input").setInputFiles(photo("IMG_2001.jpg"));
    const uploadRes = await upload;
    expect(uploadRes.status()).toBe(200);
    // The original only: no cut-out, and saved as a draft to check (not a batch).
    expect(hasPart(uploadRes.request(), "original")).toBe(true);
    expect(hasPart(uploadRes.request(), "cutout")).toBe(false);
    expect(hasPart(uploadRes.request(), "saveForReview")).toBe(false);

    await expect(page.getByRole("heading", { name: "Check the tags" })).toBeVisible();
    const description = unique("First item shirt");
    await page.getByLabel("Description").fill(description);
    const saved = page.waitForResponse((res) => res.request().method() === "POST" && path(res.url()) === "/api/items");
    await page.getByRole("button", { name: "Save to wardrobe" }).click();
    const { item } = ItemResponseSchema.parse(await (await saved).json());
    expect(item).toMatchObject({ source: "photo", cutoutUrl: null, needsReview: false, tagsEdited: true });
    await expect(page.getByText("Saved to your wardrobe")).toBeVisible();
    expect(downloads).toEqual([]);

    // Back in the (real) wardrobe, it's there, showing its original.
    await page.unroute(wardrobeList, emptyWardrobe);
    await page.unroute("**/api/outfits", noOutfits);
    await nav(page).getByRole("link", { name: "Wardrobe" }).click();
    await page.getByRole("searchbox", { name: "Search descriptions" }).fill(description);
    await expect(page.getByRole("link", { name: description })).toBeVisible();
    expect(downloads).toEqual([]);
  });

  test("several photos at once, then the review banner, the review list and Confirm all", async ({ page }) => {
    const downloads = watchModelDownloads(page);
    const adds = await recordBatchAdds(page, "**/api/items/photo");
    const mine = () => adds.items.map((i) => i.id);
    await narrowReviewListTo(page, mine);

    await openApp(page);
    await nav(page).getByRole("link", { name: "Add" }).click();
    await page.getByTestId("photo-library-input").setInputFiles([photo("IMG_3001.jpg"), photo("IMG_3002.jpg"), photo("IMG_3003.jpg")]);
    await expect(page.getByRole("heading", { name: "Adding photos" })).toBeVisible();
    await expect(page.getByText("All 3 photos added")).toBeVisible();
    await expect(page.getByText("3 items are in your wardrobe, marked to review.")).toBeVisible();

    // One after another, originals only, each saved straight away to review.
    expect(adds.requests).toHaveLength(3);
    for (const request of adds.requests) {
      expect(hasPart(request, "cutout")).toBe(false);
      expect(hasPart(request, "saveForReview")).toBe(true);
    }
    expect(adds.items).toHaveLength(3);
    for (const item of adds.items) expect(item).toMatchObject({ source: "photo", needsReview: true, cutoutUrl: null });
    expect(downloads).toEqual([]);

    // The wardrobe's banner leads to the review list.
    await nav(page).getByRole("link", { name: "Wardrobe" }).click();
    const banner = page.getByRole("link", { name: /Review \d+ new items?/ });
    await expect(banner).toBeVisible();
    const n = Number((await banner.textContent())!.match(/Review (\d+)/)![1]);
    expect(n).toBeGreaterThanOrEqual(3);
    await banner.click();
    await expect(page).toHaveURL(/\/wardrobe\/review$/);
    await expect(page.getByRole("heading", { name: "To review (3)" })).toBeVisible();
    await checkPhoneLayout(page, "review list");

    // Confirm one as it is, then the rest at once.
    const rows = page.getByRole("listitem", { name: SUGGESTED });
    await expect(rows).toHaveCount(3);
    const one = page.waitForResponse((res) => res.request().method() === "PATCH");
    await rows.first().getByRole("button", { name: /^Looks right/ }).click();
    const oneRes = await one;
    expect(oneRes.status()).toBe(200);
    expect(oneRes.request().postDataJSON()).toEqual({ reviewed: true });
    await expect(page.getByRole("heading", { name: "To review (2)" })).toBeVisible();

    const all = page.waitForResponse((res) => path(res.url()) === "/api/items/reviewed");
    await page.getByRole("button", { name: "Confirm all 2" }).click();
    const allRes = await all;
    expect(allRes.status()).toBe(200);
    const confirmedIds = (allRes.request().postDataJSON() as { itemIds: string[] }).itemIds;
    expect(confirmedIds).toHaveLength(2);
    expect(mine()).toEqual(expect.arrayContaining(confirmedIds));
    await expect(page.getByText("All caught up")).toBeVisible();

    // The server agrees: none of the three is still to review.
    for (const id of mine()) expect((await getItem(page, id)).needsReview).toBe(false);
    expect(downloads).toEqual([]);
  });

  test("several links pasted at once, one needing the screenshot fallback", async ({ page }) => {
    const downloads = watchModelDownloads(page);
    const step2 = await recordBatchAdds(page, "**/api/items/link/cutout");
    const screenshot = await recordBatchAdds(page, "**/api/items/photo");
    const stamp = Date.now();
    const a = `https://shop.example.com/p/journey-a-${stamp}`;
    const b = `https://shop.example.com/p/journey-b-${stamp}`;
    const blocked = `https://blocked.example.com/p/journey-${stamp}`;

    await openApp(page);
    await nav(page).getByRole("link", { name: "Add" }).click();
    await page.getByRole("link", { name: "Paste a product link" }).click();
    await page.getByLabel("Product links").fill(`From my basket:\n${a}\n${blocked}\n${b}`);
    await expect(page.getByText("3 different links found.")).toBeVisible();
    await page.getByRole("button", { name: "Add 3 links" }).click();

    await expect(page.getByText("Done", { exact: true })).toBeVisible();
    await expect(page.getByText("2 items are in your wardrobe, marked to review.")).toBeVisible();
    await expect(page.getByText("1 link needs a screenshot: the site couldn't be read. Add them below.")).toBeVisible();
    expect(step2.items.map((i) => i.sourceUrl).sort()).toEqual([a, b].sort());
    for (const request of step2.requests) expect(hasPart(request, "cutout")).toBe(false);
    for (const item of step2.items) expect(item).toMatchObject({ source: "link", needsReview: true, cutoutUrl: null });

    // The one listed at the end takes a screenshot, down the photo route with its link.
    const blockedRow = page.getByRole("list", { name: "Links" }).getByRole("listitem").filter({ hasText: "blocked.example.com" });
    await blockedRow.getByTestId("screenshot-input").setInputFiles(photo("screenshot.jpg"));
    await expect(blockedRow).toContainText(`Added: ${SUGGESTED}`);
    await expect(page.getByText("All 3 links added")).toBeVisible();
    expect(screenshot.items).toHaveLength(1);
    expect(screenshot.items[0]).toMatchObject({ source: "link", sourceUrl: blocked, needsReview: true, cutoutUrl: null });
    expect(hasPart(screenshot.requests[0]!, "cutout")).toBe(false);
    await checkPhoneLayout(page, "link batch summary");

    // All three are in the wardrobe, keeping their links.
    for (const item of [...step2.items, ...screenshot.items]) {
      const stored = await getItem(page, item.id);
      expect(stored.sourceUrl).toBe(item.sourceUrl);
    }
    expect(downloads).toEqual([]);
  });

  test("settings: the forwarding address to copy, and favourite shops", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const before = (await (await page.request.get("/api/settings")).json()) as { favouriteShopIds: string[]; forwardingAddress: string };
    try {
      await openApp(page);
      await page.getByRole("button", { name: "Account" }).click();
      await page.getByRole("dialog", { name: "Account" }).getByRole("link", { name: /Settings/ }).click();
      await expect(page).toHaveURL(/\/settings$/);

      // The private forwarding address, with who it must come from.
      const address = page.getByTestId("forwarding-address");
      await expect(address).toHaveText(before.forwardingAddress);
      expect(before.forwardingAddress).toMatch(/^[0-9a-f]{32}@/);
      await expect(page.getByText(`Forward it to the address above, from ${MOCK_EMAIL}.`)).toBeVisible();
      await page.getByRole("button", { name: "Copy address" }).click();
      await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(before.forwardingAddress);

      // Favourite shops: the defaults are ticked; add one and save.
      for (const shop of ["Next", "M&S", "New Look"]) await expect(page.getByRole("checkbox", { name: shop, exact: true })).toBeChecked();
      await expect(page.getByRole("checkbox", { name: "Uniqlo", exact: true })).not.toBeChecked();
      await page.getByText("Uniqlo", { exact: true }).click();
      const put = page.waitForResponse((r) => r.request().method() === "PUT" && path(r.url()) === "/api/settings");
      await page.getByRole("button", { name: "Save shops" }).click();
      expect((await put).status()).toBe(200);
      await expect(page.getByText("Shops saved.")).toBeVisible();
      const after = await (await page.request.get("/api/settings")).json();
      expect(after.favouriteShopIds).toEqual(expect.arrayContaining(["next", "marks_and_spencer", "new_look", "uniqlo"]));
      await checkPhoneLayout(page, "settings");

      // Kept after a reload.
      await page.reload();
      await expect(page.getByRole("checkbox", { name: "Uniqlo", exact: true })).toBeChecked();
    } finally {
      // Other tests search the default shops.
      await page.request.put("/api/settings", { data: { favouriteShopIds: before.favouriteShopIds } });
    }
  });

  test("a forwarded order email (recorded fixture) shows its items to review, and in settings", async ({ page }) => {
    const before = new Set(await toReviewIds(page));
    await postOrderEmail(page, `<journey-${Date.now()}-${Math.random()}@mail.example>`);

    const newItems = ItemListResponseSchema.parse(await (await page.request.get("/api/items?needsReview=true")).json()).items.filter(
      (i) => !before.has(i.id) && i.source === "email",
    );
    // Another test may forward one at the same moment: take this email's two.
    const polo = newItems.find((i) => !i.needsPhoto)!;
    const chinos = newItems.find((i) => i.needsPhoto)!;
    expect(polo).toBeDefined();
    expect(chinos).toBeDefined();
    const mine = [polo.id, chinos.id];
    await narrowReviewListTo(page, () => mine);

    await openApp(page);
    await expect(page.getByRole("link", { name: /Review \d+ new items?/ })).toBeVisible();
    await page.getByRole("link", { name: /Review \d+ new items?/ }).click();
    await expect(page.getByRole("heading", { name: "To review (2)" })).toBeVisible();
    const poloRow = page.getByRole("listitem", { name: polo.tags.description });
    const chinosRow = page.getByRole("listitem", { name: chinos.tags.description });
    await expect(poloRow.getByText("From an order email")).toBeVisible();
    await expect(chinosRow.getByText("From an order email")).toBeVisible();
    // The line without a usable picture is flagged to add one.
    await expect(chinosRow.getByText("No picture came with this one.")).toBeVisible();
    await expect(poloRow.getByText("No picture came with this one.")).toHaveCount(0);
    await checkPhoneLayout(page, "review list with email items");

    // Settings lists the email and what it added.
    await page.goto("/settings");
    const row = page.getByRole("listitem").filter({ hasText: "M&S · 30 Oct" }).filter({ hasText: "Added 2 items to review" });
    await expect(row.first()).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Journey 2: outfits for an occasion, from a sparse wardrobe
// ---------------------------------------------------------------------------

test.describe("journey 2: outfits for an occasion from a sparse wardrobe", () => {
  test("a wardrobe with no shoes gets outfits with gap placeholders and an 'add shoes' notice", async ({ page }) => {
    await openApp(page);
    // mock-gaps plays a wardrobe without shoes (CONTRACTS.md section 1).
    const { outfits, missingCategories, sent } = await askForOutfits(page, { style: "Casual", guidance: "mock-gaps" });
    expect(sent).toMatchObject({ style: { kind: "preset", presetId: "casual" }, guidance: "mock-gaps" });
    expect(sent).not.toHaveProperty("includeShopItems");
    expect(missingCategories).toEqual(["shoes"]);
    expect(outfits.length).toBeGreaterThanOrEqual(3);

    const notice = page.getByTestId("missing-categories");
    await expect(notice).toContainText("Add shoes to your wardrobe to complete these outfits.");
    await expect(notice.getByRole("link", { name: "Add clothes" })).toHaveAttribute("href", "/add");

    await expect(outfitCards(page)).toHaveCount(outfits.length);
    for (const outfit of outfits) {
      // Every outfit has an owned piece, and its shoes are a gap the model described.
      expect(outfit.items.length).toBeGreaterThan(0);
      expect(outfit.gaps.map((g) => g.category)).toEqual(["shoes"]);
      expect(outfit.items.some((i) => i.tags.category === "shoes")).toBe(false);
      await expectGapsShown(card(page, outfit.id), outfit);
    }
    await checkPhoneLayout(page, "outfits with gaps");

    // The notice's way out goes to Add.
    await notice.getByRole("link", { name: "Add clothes" }).click();
    await expect(page.getByRole("heading", { name: "Add an item" })).toBeVisible();
  });

  test("include items from my shops, find in my shops, pick a product, then I've bought this adds it by link", async ({ page }) => {
    await openApp(page);
    const { outfits, missingCategories, sent } = await askForOutfits(page, { style: "Casual", shopItems: true });
    expect(sent.includeShopItems).toBe(true);
    expect(missingCategories).toEqual([]);
    await expect(page.getByText("With items from your shops")).toBeVisible();
    for (const outfit of outfits) {
      expect(outfit.request.includeShopItems).toBe(true);
      expect(outfit.gaps.length).toBeLessThanOrEqual(1);
    }

    const outfit = outfits.find((o) => o.gaps.length === 1)!;
    const outfitCard = card(page, outfit.id);
    await expectGapsShown(outfitCard, outfit);

    // Find in my shops: up to three products per gap, from the chosen shops only.
    const search = page.waitForResponse((r) => path(r.url()) === `/api/outfits/${outfit.id}/shop-search`);
    await outfitCard.getByRole("button", { name: "Find in my shops" }).click();
    expect((await search).status()).toBe(200);
    const products = outfitCard.getByTestId("product-card");
    await expect(products.first()).toBeVisible();
    const count = await products.count();
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThanOrEqual(3);
    const shopLinks = await products.getByRole("link", { name: /^View in / }).evaluateAll((els) => els.map((el) => el.getAttribute("href")!));
    for (const href of shopLinks) expect(new URL(href).hostname).toMatch(/(^|\.)(next\.co\.uk|marksandspencer\.com|newlook\.com)$/);
    await checkPhoneLayout(page, "shop products");

    // Pick the first: the server keeps it on the gap; the collage keeps its dashed placeholder.
    const first = products.first();
    const title = (await first.locator("p").first().textContent())!.trim();
    const productUrl = shopLinks[0]!;
    const pick = page.waitForResponse((r) => r.request().method() === "PUT" && path(r.url()) === `/api/outfits/${outfit.id}/gaps/${outfit.gaps[0]!.category}`);
    await first.getByRole("button", { name: "Pick this" }).click();
    expect((await pick).status()).toBe(200);
    await expect(first).toHaveAttribute("data-chosen", "true");
    const stored = OutfitResponseSchema.parse(await (await page.request.get(`/api/outfits/${outfit.id}`)).json()).outfit;
    expect(stored.gaps[0]!.shopProduct).toMatchObject({ title, url: productUrl });
    await expect(outfitCard.getByTestId("outfit-collage")).toHaveAttribute("aria-label", new RegExp(`suggested ${escapeRegExp(title)}`));
    await expectCollageReady(outfitCard);

    // "I've bought this" goes to add-by-link with the product's link, and it's added.
    await outfitCard.getByTestId("chosen-product").getByRole("link", { name: /^I've bought this/ }).click();
    await expect(page).toHaveURL(/\/add\/link\?url=/);
    expect(new URL(page.url()).searchParams.get("url")).toBe(productUrl);
    await expect(page.getByLabel("Product links")).toHaveValue(productUrl);
    const step2 = page.waitForResponse((res) => path(res.url()) === "/api/items/link/cutout");
    await page.getByRole("button", { name: "Import this link" }).click();
    expect((await step2).status()).toBe(200);
    expect(hasPart((await step2).request(), "cutout")).toBe(false);
    await expect(page.getByRole("heading", { name: "Check the tags" })).toBeVisible();
    const description = unique("Bought from my shops");
    await page.getByLabel("Description").fill(description);
    const saved = page.waitForResponse((res) => res.request().method() === "POST" && path(res.url()) === "/api/items");
    await page.getByRole("button", { name: "Save to wardrobe" }).click();
    const { item } = ItemResponseSchema.parse(await (await saved).json());
    expect(item).toMatchObject({ source: "link", sourceUrl: productUrl, cutoutUrl: null });
    await expect(page.getByText("Saved to your wardrobe")).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Journey 3: build around an item
// ---------------------------------------------------------------------------

test.describe("journey 3: build around an item", () => {
  test("an item just added (still to review) can anchor outfits; each includes it, complete from the wardrobe", async ({ page }) => {
    const adds = await recordBatchAdds(page, "**/api/items/photo");
    await openApp(page);
    await nav(page).getByRole("link", { name: "Add" }).click();
    await page.getByTestId("photo-library-input").setInputFiles([photo("IMG_4001.jpg"), photo("IMG_4002.jpg")]);
    await expect(page.getByText("All 2 photos added")).toBeVisible();
    const anchor = adds.items[0]!;
    expect(anchor.needsReview).toBe(true);

    await page.goto(`/wardrobe/${anchor.id}`);
    await expect(page.getByRole("heading", { name: anchor.tags.description })).toBeVisible();
    await page.getByRole("link", { name: "Build an outfit around this" }).click();
    await expect(page).toHaveURL(new RegExp(`/outfits\\?anchor=${anchor.id}$`));
    await expect(page.getByTestId("anchor-item")).toContainText(anchor.tags.description);

    await tapRadio(page, "Casual");
    const response = outfitsResponse(page, /^\/api\/outfits$/);
    await page.getByRole("button", { name: "Get outfits" }).click();
    const { outfits, missingCategories } = await okOutfits(await response);
    expect((await response).request().postDataJSON()).toMatchObject({ anchorItemId: anchor.id });
    expect(missingCategories).toEqual([]);
    expect(outfits.length).toBeGreaterThanOrEqual(1);
    for (const outfit of outfits) {
      expect(outfit.itemIds).toContain(anchor.id);
      // The stocked wardrobe fills every slot, so no gaps without asking for shop items.
      expect(outfit.gaps).toEqual([]);
      const outfitCard = card(page, outfit.id);
      await expect(
        outfitCard.getByRole("list", { name: "Items in this outfit" }).getByRole("listitem").filter({ hasText: anchor.tags.description }).first(),
      ).toContainText("Your pick");
      await expect(outfitCard.getByTestId("outfit-collage")).toHaveAttribute("data-gaps", "0");
      await expectCollageReady(outfitCard);
    }
  });
});

// ---------------------------------------------------------------------------
// Journey 4: refine and swap
// ---------------------------------------------------------------------------

test.describe("journey 4: refine and swap", () => {
  test("on an outfit with a gap: swap an owned item, then tweak the revised one", async ({ page }) => {
    await openApp(page);
    const { outfits } = await askForOutfits(page, { style: "Casual", shopItems: true });
    const parent = outfits.find((o) => o.gaps.length === 1 && o.items.length >= 2)!;
    expect(parent).toBeDefined();
    const parentCard = card(page, parent.id);
    await expectGapsShown(parentCard, parent);
    // Gaps can't be swapped (there's nothing owned to swap out), owned items can.
    await expect(parentCard.getByTestId("gap-row").getByRole("button", { name: /^Swap/ })).toHaveCount(0);

    const swapped = parent.items[0]!;
    let response = outfitsResponse(page, /^\/api\/outfits\/[^/]+\/refine$/);
    await parentCard.getByRole("button", { name: `Swap ${swapped.tags.description}` }).click();
    const revised = (await okOutfits(await response)).outfits;
    expect(path((await response).url())).toBe(`/api/outfits/${parent.id}/refine`);
    expect((await response).request().postDataJSON()).toEqual({ kind: "swap", itemId: swapped.id });
    await expect(page.getByRole("heading", { name: `Swapped out the ${swapped.tags.description.toLowerCase()}` })).toBeVisible();
    expect(revised.length).toBeGreaterThan(0);
    for (const outfit of revised) {
      expect(outfit.parentOutfitId).toBe(parent.id);
      expect(outfit.itemIds).not.toContain(swapped.id);
      // The request carries over, shop items included.
      expect(outfit.request.includeShopItems).toBe(true);
      expect(outfit.items.length).toBeGreaterThan(0);
      expect(outfit.gaps.length).toBeLessThanOrEqual(1);
    }
    await expect(outfitCards(page)).toHaveCount(revised.length);
    for (const outfit of revised) await expectGapsShown(card(page, outfit.id), outfit);

    // Then guidance on the first revised outfit.
    const second = revised[0]!;
    response = outfitsResponse(page, /^\/api\/outfits\/[^/]+\/refine$/);
    await card(page, second.id).getByRole("button", { name: "Tweak this outfit" }).click();
    await card(page, second.id).getByPlaceholder("Or say what to change").fill("warmer");
    await card(page, second.id).getByRole("button", { name: "Update" }).click();
    const tweaked = (await okOutfits(await response)).outfits;
    expect(path((await response).url())).toBe(`/api/outfits/${second.id}/refine`);
    await expect(page.getByRole("heading", { name: "Tweaked: warmer" })).toBeVisible();
    expect(tweaked.length).toBeGreaterThan(0);
    for (const outfit of tweaked) {
      expect(outfit.parentOutfitId).toBe(second.id);
      expect(outfit.request.includeShopItems).toBe(true);
      await expectGapsShown(card(page, outfit.id), outfit);
    }
  });

  test("on an outfit from a wardrobe missing shoes: a swap gives a revised set pointing back to it", async ({ page }) => {
    await openApp(page);
    const { outfits } = await askForOutfits(page, { style: "Casual", guidance: "mock-gaps" });
    const parent = outfits.find((o) => o.items.length >= 2)!;
    const swapped = parent.items.find((i) => i.tags.category === "top") ?? parent.items[0]!;
    const response = outfitsResponse(page, /^\/api\/outfits\/[^/]+\/refine$/);
    await card(page, parent.id).getByRole("button", { name: `Swap ${swapped.tags.description}` }).click();
    const revised = (await okOutfits(await response)).outfits;
    expect(revised.length).toBeGreaterThan(0);
    for (const outfit of revised) {
      expect(outfit.parentOutfitId).toBe(parent.id);
      expect(outfit.itemIds).not.toContain(swapped.id);
      expect(outfit.request.guidance).toBe("mock-gaps");
      await expectGapsShown(card(page, outfit.id), outfit);
    }
    await expect(outfitCards(page)).toHaveCount(revised.length);
  });
});

// ---------------------------------------------------------------------------
// Journey 5: save and rate
// ---------------------------------------------------------------------------

test.describe("journey 5: save and rate", () => {
  test("save, like and reject outfits with gaps; the saved ones show their gaps", async ({ page }) => {
    await openApp(page);
    const { outfits } = await askForOutfits(page, { style: "Casual", guidance: "mock-gaps" });
    expect(outfits.length).toBeGreaterThanOrEqual(3);
    const [saved, liked, rejected] = outfits as [Outfit, Outfit, Outfit];

    try {
      await card(page, saved.id).getByRole("button", { name: "Save", exact: true }).click();
      await expect(card(page, saved.id).getByRole("button", { name: "Saved", exact: true })).toHaveAttribute("aria-pressed", "true");
      await card(page, liked.id).getByRole("button", { name: "Like", exact: true }).click();
      await expect(card(page, liked.id).getByRole("button", { name: "Liked", exact: true })).toHaveAttribute("aria-pressed", "true");

      await card(page, rejected.id).getByRole("button", { name: "Reject", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Not for you?" });
      await dialog.getByLabel("Why not? (optional)").fill("Never with sandals");
      const patch = page.waitForResponse((res) => res.request().method() === "PATCH" && path(res.url()) === `/api/outfits/${rejected.id}`);
      await dialog.getByRole("button", { name: "Reject outfit" }).click();
      expect((await patch).status()).toBe(200);
      await expect(card(page, rejected.id)).toHaveAttribute("data-status", "rejected");

      for (const [outfit, status] of [
        [saved, "saved"],
        [liked, "liked"],
        [rejected, "rejected"],
      ] as const) {
        const res = await page.request.get(`/api/outfits/${outfit.id}`);
        expect(OutfitResponseSchema.parse(await res.json()).outfit.status).toBe(status);
      }

      await nav(page).getByRole("link", { name: "Saved" }).click();
      await expect(page).toHaveURL(/\/outfits\/saved$/);
      await expect(page.getByRole("heading", { name: "Saved outfits" })).toBeVisible();
      for (const outfit of [saved, liked]) {
        await expect(card(page, outfit.id)).toBeVisible();
        await expectGapsShown(card(page, outfit.id), outfit);
      }
      await expect(card(page, rejected.id)).toHaveCount(0);
      await checkPhoneLayout(page, "saved outfits with gaps");
    } finally {
      for (const outfit of [saved, liked, rejected]) {
        await page.request.patch(`/api/outfits/${outfit.id}`, { data: { status: "suggested" } });
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Cut-outs when a collage first needs an item
// ---------------------------------------------------------------------------

test.describe("collage-time cut-outs", () => {
  test("an item added without a cut-out is cut out once by its first collage, uploaded and reused", async ({ page }) => {
    // Opt in to collage cut-outs (automated browsers skip them), with the fake remover.
    await installFakeBackgroundRemover(page);
    await page.addInitScript((png) => {
      const w = window as unknown as { __GLADRAGS_TEST_COLLAGE_CUTOUTS__?: boolean; __GLADRAGS_TEST_REMOVER_RESULT__?: string };
      w.__GLADRAGS_TEST_COLLAGE_CUTOUTS__ = true;
      w.__GLADRAGS_TEST_REMOVER_RESULT__ = png;
    }, RED_PIXEL_PNG);
    const downloads = watchModelDownloads(page);

    // Add an item of our own (so no other test's item gains a cut-out).
    await openApp(page);
    await nav(page).getByRole("link", { name: "Add" }).click();
    await page.getByTestId("photo-library-input").setInputFiles(photo("IMG_5001.jpg"));
    await expect(page.getByRole("heading", { name: "Check the tags" })).toBeVisible();
    const description = unique("Collage cut-out shirt");
    await page.getByLabel("Description").fill(description);
    const saved = page.waitForResponse((res) => res.request().method() === "POST" && path(res.url()) === "/api/items");
    await page.getByRole("button", { name: "Save to wardrobe" }).click();
    const { item } = ItemResponseSchema.parse(await (await saved).json());
    expect(item.cutoutUrl).toBeNull();

    // Let the uploads through to the server, keeping what was sent.
    const uploads: (Buffer | null)[] = [];
    await page.route(`**/api/items/${item.id}/cutout`, async (route) => {
      if (route.request().method() === "PUT") uploads.push(route.request().postDataBuffer());
      await route.continue();
    });

    // Build around it: its collages cut it out in the browser and upload the cut-out.
    await page.goto(`/outfits?anchor=${item.id}`);
    await tapRadio(page, "Casual");
    const uploaded = page.waitForResponse((r) => r.request().method() === "PUT" && path(r.url()) === `/api/items/${item.id}/cutout`);
    const response = outfitsResponse(page, /^\/api\/outfits$/);
    await page.getByRole("button", { name: "Get outfits" }).click();
    const { outfits } = await okOutfits(await response);
    expect(outfits.length).toBeGreaterThanOrEqual(1);
    const uploadRes = await uploaded;
    expect(uploadRes.status()).toBe(200);
    expect(uploads[0]!.includes(Buffer.from('name="cutout"'))).toBe(true);
    expect(uploads[0]!.includes(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe(true);
    expect(ItemResponseSchema.parse(await uploadRes.json()).item.cutoutUrl).not.toBeNull();

    for (const outfit of outfits) {
      const outfitCard = card(page, outfit.id);
      await expectCollageReady(outfitCard);
      await expect(outfitCard.getByTestId("outfit-collage")).toHaveAttribute("data-cutouts", /^[1-9]/);
    }
    // Stored on the item, and only one upload however many collages use it.
    expect((await getItem(page, item.id)).cutoutUrl).not.toBeNull();
    expect(uploads).toHaveLength(1);

    // Next time (a fresh page), the stored cut-out is used: nothing is cut out or uploaded again.
    await page.goto(`/outfits?anchor=${item.id}`);
    await tapRadio(page, "Smart casual");
    const again = outfitsResponse(page, /^\/api\/outfits$/);
    await page.getByRole("button", { name: "Get outfits" }).click();
    const second = await okOutfits(await again);
    for (const outfit of second.outfits) {
      expect(outfit.items.find((i) => i.id === item.id)!.cutoutUrl).not.toBeNull();
      await expectCollageReady(card(page, outfit.id));
    }
    await page.waitForTimeout(500);
    expect(uploads).toHaveLength(1);
    // The fake remover stood in for the model: nothing was downloaded.
    expect(downloads).toEqual([]);
  });
});

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
