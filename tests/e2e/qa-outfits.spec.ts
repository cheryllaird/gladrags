import { deflateSync, crc32 } from "node:zlib";
import { expect, test, type Locator, type Page, type Route } from "@playwright/test";

// QA gap tests for the outfit screens (journeys 2-5), 390 px, mock mode.
// Complements outfits.spec.ts. Most outfit responses here are intercepted
// with contract-shaped data, so these tests use only a few of the mock
// user's 25 daily outfit requests (restart a reused dev server between runs).
//
// Tests marked test.fail() pin a known problem reported to the orchestrator:
// they pass while the problem exists, and flag when it's fixed.

const IMG_HOST = "https://img.gladrags.test";
const NAVY_BLAZER_ID = "1a000000-0000-4000-8000-000000000008";
const UNKNOWN_ID = "1a000000-0000-4000-8000-0000000000ff";

// ---------------------------------------------------------------------------
// Test images: tiny PNGs made here, served from another origin
// ---------------------------------------------------------------------------

function png(width: number, height: number, pixel: (x: number, y: number) => [number, number, number, number]): Buffer {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixel(x, y);
      raw.set([r, g, b, a], y * (width * 4 + 1) + 1 + x * 4);
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const RED: [number, number, number, number] = [220, 30, 30, 255];
const IMAGES: Record<string, Buffer> = {
  "solid.png": png(120, 150, () => RED),
  "tall.png": png(20, 1200, () => RED),
  "wide.png": png(1200, 20, () => RED),
  "transparent.png": png(200, 200, () => [0, 0, 0, 0]),
  // A cut-out: a red block in the middle of a transparent frame.
  "cutout.png": png(400, 400, (x, y) => (x > 150 && x < 250 && y > 100 && y < 300 ? RED : [0, 0, 0, 0])),
  "original.png": png(120, 150, () => [30, 30, 220, 255]),
};

/**
 * Serve IMAGES from IMG_HOST with CORS headers. `missing` names files that
 * 404. Returns the requested paths.
 */
async function serveImages(page: Page, options: { missing?: string[] } = {}) {
  const requested: string[] = [];
  await page.route(`${IMG_HOST}/**`, async (route: Route) => {
    const name = new URL(route.request().url()).pathname.slice(1);
    requested.push(name);
    if (options.missing?.includes(name) || !IMAGES[name]) {
      await route.fulfill({ status: 404, body: "not found", headers: { "access-control-allow-origin": "*" } });
      return;
    }
    await route.fulfill({
      status: 200,
      body: IMAGES[name],
      contentType: "image/png",
      headers: { "access-control-allow-origin": "*" },
    });
  });
  return requested;
}

// ---------------------------------------------------------------------------
// Contract-shaped outfits
// ---------------------------------------------------------------------------

type Category = "top" | "bottom" | "dress_jumpsuit" | "outerwear" | "shoes";
const SUB: Record<Category, string> = {
  top: "t_shirt",
  bottom: "jeans",
  dress_jumpsuit: "dress",
  outerwear: "coat",
  shoes: "trainers",
};

let idCounter = 0;
const newId = (prefix: string) => `${prefix}-0000-4000-8000-${String(++idCounter).padStart(12, "0")}`;

function wardrobeItem(
  category: Category,
  options: { cutout?: string | null; original?: string; description?: string } = {},
) {
  const original = options.original ?? "solid.png";
  const cutout = options.cutout === undefined ? original : options.cutout;
  return {
    id: newId("3c000000"),
    source: "photo",
    sourceUrl: null,
    originalUrl: `${IMG_HOST}/${original}`,
    cutoutUrl: cutout === null ? null : `${IMG_HOST}/${cutout}`,
    tags: {
      category,
      subcategory: SUB[category],
      colours: ["red"],
      pattern: "plain",
      formality: 2,
      seasons: ["spring", "summer", "autumn", "winter"],
      warmth: "medium",
      occasions: ["casual"],
      fabric: "",
      description: options.description ?? `Test ${category.replace("_", " ")}`,
    },
    tagsEdited: false,
    needsReview: false,
    needsPhoto: false,
    createdAt: "2026-10-25T09:00:00.000Z",
  };
}

type Item = ReturnType<typeof wardrobeItem>;

function outfit(items: Item[], options: { name?: string; status?: string; createdAt?: string; style?: string } = {}) {
  return {
    id: newId("4d000000"),
    request: { style: { kind: "preset", presetId: options.style ?? "casual" }, guidance: null, anchorItemId: null },
    name: options.name ?? `QA outfit ${idCounter}`,
    reason: "Picked by the QA test",
    itemIds: items.map((i) => i.id),
    items,
    status: options.status ?? "suggested",
    parentOutfitId: null,
    createdAt: options.createdAt ?? "2026-10-25T10:00:00.000Z",
  };
}

type Outfit = ReturnType<typeof outfit>;

const basicOutfit = (name?: string) =>
  outfit([wardrobeItem("top"), wardrobeItem("bottom"), wardrobeItem("shoes")], { name });

/** Intercept POST /api/outfits with a fixed answer. */
async function fakeRequest(page: Page, body: unknown, status = 200) {
  await page.route(/\/api\/outfits$/, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    await route.fulfill({ status, json: body });
  });
}

/**
 * Intercept PATCH /api/outfits/:id for fake outfits, echoing the outfit back
 * with its new status. Returns the bodies sent.
 */
async function fakeStatusChanges(page: Page, outfits: Outfit[], fail = false) {
  const sent: unknown[] = [];
  await page.route(/\/api\/outfits\/[^/]+$/, async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    const body = route.request().postDataJSON() as { status: string };
    sent.push(body);
    if (fail) {
      await route.fulfill({ status: 500, json: { error: { code: "internal", message: "Database unavailable" } } });
      return;
    }
    const id = new URL(route.request().url()).pathname.split("/").pop();
    const found = outfits.find((o) => o.id === id);
    if (!found) return route.fallback();
    found.status = body.status;
    await route.fulfill({ json: { outfit: found } });
  });
  return sent;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "canShare", { value: undefined, configurable: true });
  });
});

async function tapRadio(page: Page, name: string) {
  const radio = page.getByRole("radio", { name, exact: true });
  await radio.locator("xpath=ancestor::label[1]").click();
  await expect(radio).toBeChecked();
}

const cards = (page: Page) => page.getByTestId("outfit-card");

async function askFor(page: Page, style = "Casual") {
  await tapRadio(page, style);
  await page.getByRole("button", { name: "Get outfits" }).click();
}

async function expectNoSidewaysScroll(page: Page, where: string) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, `sideways scroll on ${where}`).toBeLessThanOrEqual(0);
}

/** Every visible button and link inside `scope` is at least 44 px tall (and 24 px wide). */
async function expectTapTargets(scope: Locator, where: string) {
  const targets = scope.locator("button:visible, a:visible, [role=radio]:visible");
  const count = await targets.count();
  expect(count, `no tap targets on ${where}`).toBeGreaterThan(0);
  for (let i = 0; i < count; i++) {
    const t = targets.nth(i);
    const box = await t.boundingBox();
    const label = (await t.getAttribute("aria-label")) ?? (await t.innerText());
    expect(box?.height, `${where}: "${label}" height`).toBeGreaterThanOrEqual(44);
    expect(box?.width, `${where}: "${label}" width`).toBeGreaterThanOrEqual(24);
  }
}

/** Export the collage the way "Save image" does; throws if the canvas is tainted. */
function exportCollage(canvas: Locator) {
  return canvas.evaluate((el: HTMLCanvasElement) => el.toDataURL("image/png").length);
}

/** RGBA of the collage pixel at a fraction of its width and height. */
function collagePixel(canvas: Locator, fx: number, fy: number) {
  return canvas.evaluate(
    (el: HTMLCanvasElement, [x, y]) => Array.from(el.getContext("2d")!.getImageData(Math.round(el.width * x), Math.round(el.height * y), 1, 1).data),
    [fx, fy] as const,
  );
}

// ---------------------------------------------------------------------------
// Collage
// ---------------------------------------------------------------------------

test.describe("collage", () => {
  test("every composition shape draws, from cross-origin images, and exports as an image", async ({ page }) => {
    await serveImages(page);
    const shapes = [
      outfit([wardrobeItem("top"), wardrobeItem("bottom"), wardrobeItem("shoes")], { name: "Separates" }),
      outfit([wardrobeItem("top"), wardrobeItem("bottom"), wardrobeItem("shoes"), wardrobeItem("outerwear")], {
        name: "Separates and coat",
      }),
      outfit([wardrobeItem("dress_jumpsuit"), wardrobeItem("shoes")], { name: "Dress" }),
      outfit([wardrobeItem("dress_jumpsuit"), wardrobeItem("shoes"), wardrobeItem("outerwear")], { name: "Dress and coat" }),
    ];
    await fakeRequest(page, { status: "ok", outfits: shapes });
    await page.goto("/outfits");
    await askFor(page);
    await expect(cards(page)).toHaveCount(4);
    for (let i = 0; i < 4; i++) {
      const canvas = cards(page).nth(i).getByTestId("outfit-collage");
      await expect(canvas).toHaveAttribute("data-state", "ready");
      expect(await exportCollage(canvas)).toBeGreaterThan(1000);
    }
    // Outerwear sits to the right: red there only when there's a coat.
    const coatSide = await collagePixel(cards(page).nth(1).getByTestId("outfit-collage"), 0.8, 0.35);
    const noCoatSide = await collagePixel(cards(page).nth(0).getByTestId("outfit-collage"), 0.8, 0.35);
    expect(coatSide.slice(0, 3)).toEqual([220, 30, 30]);
    expect(noCoatSide.slice(0, 3)).not.toEqual([220, 30, 30]);

    const download = page.waitForEvent("download");
    await cards(page).nth(3).getByRole("button", { name: "Save image of Dress and coat" }).click();
    expect((await download).suggestedFilename()).toBe("gladrags-dress-and-coat.png");
  });

  test("an item with no cut-out uses its original image, and never asks for a cut-out", async ({ page }) => {
    const requested = await serveImages(page);
    const top = wardrobeItem("top", { cutout: null, original: "original.png" });
    await fakeRequest(page, { status: "ok", outfits: [outfit([top, wardrobeItem("bottom"), wardrobeItem("shoes")])] });
    await page.goto("/outfits");
    await askFor(page);
    const canvas = cards(page).first().getByTestId("outfit-collage");
    await expect(canvas).toHaveAttribute("data-state", "ready");
    expect(requested).toContain("original.png");
    // The top's slot (upper centre) shows the original's blue.
    expect((await collagePixel(canvas, 0.5, 0.2)).slice(0, 3)).toEqual([30, 30, 220]);
    // The item list's thumbnail uses the original too.
    await expect(cards(page).first().getByRole("listitem").first().locator("img")).toHaveAttribute(
      "src",
      `${IMG_HOST}/original.png`,
    );
  });

  test("a cut-out's transparent margin is trimmed so the item fills its slot", async ({ page }) => {
    await serveImages(page);
    await fakeRequest(page, {
      status: "ok",
      outfits: [outfit([wardrobeItem("top", { cutout: "cutout.png" }), wardrobeItem("bottom"), wardrobeItem("shoes")])],
    });
    await page.goto("/outfits");
    await askFor(page);
    const canvas = cards(page).first().getByTestId("outfit-collage");
    await expect(canvas).toHaveAttribute("data-state", "ready");
    // The block is 99 x 199 px inside a 400 x 400 frame. Untrimmed, it would
    // start about 163 px down the canvas; trimmed (and scaled 2x) it starts
    // about 85 px down, so the pixel at 9% of the height is red only if trimmed.
    expect((await collagePixel(canvas, 0.5, 0.09)).slice(0, 3)).toEqual([220, 30, 30]);
  });

  test("very tall, very wide and fully transparent images draw without breaking the collage", async ({ page }) => {
    await serveImages(page);
    await fakeRequest(page, {
      status: "ok",
      outfits: [
        outfit([wardrobeItem("top", { original: "tall.png" }), wardrobeItem("bottom", { original: "wide.png" }), wardrobeItem("shoes")], {
          name: "Extreme shapes",
        }),
        outfit([wardrobeItem("dress_jumpsuit", { original: "transparent.png" }), wardrobeItem("shoes")], {
          name: "Invisible dress",
        }),
      ],
    });
    await page.goto("/outfits");
    await askFor(page);
    for (let i = 0; i < 2; i++) {
      const canvas = cards(page).nth(i).getByTestId("outfit-collage");
      await expect(canvas).not.toHaveAttribute("data-state", "loading");
      expect(await exportCollage(canvas)).toBeGreaterThan(1000);
    }
    // The tall top is drawn in the upper slot's centre column.
    expect((await collagePixel(cards(page).nth(0).getByTestId("outfit-collage"), 0.5, 0.2)).slice(0, 3)).toEqual([220, 30, 30]);
    await expectNoSidewaysScroll(page, "results with extreme images");
  });

  // QA finding, fixed: a fully transparent cut-out used to be reported
  // "ready" with its slot left empty.
  test("a fully transparent image gets a placeholder or a message, not an empty slot", async ({ page }) => {
    await serveImages(page);
    await fakeRequest(page, {
      status: "ok",
      outfits: [outfit([wardrobeItem("dress_jumpsuit", { original: "transparent.png" }), wardrobeItem("shoes")])],
    });
    await page.goto("/outfits");
    await askFor(page);
    const card = cards(page).first();
    await expect(card.getByTestId("outfit-collage")).not.toHaveAttribute("data-state", "loading");
    await expect(card.getByText("Some pictures couldn't load.")).toBeVisible({ timeout: 2000 });
  });

  test("an image without CORS headers, or missing, gets a placeholder; the canvas still exports", async ({ page, baseURL }) => {
    // Playwright's route.fulfill answers CORS requests itself, so the no-CORS
    // image comes from the app's own server under a second origin
    // (127.0.0.1 instead of localhost), which sends no CORS headers.
    const other = new URL(baseURL!);
    test.skip(other.hostname !== "localhost", "needs a localhost base URL to make a second origin");
    other.hostname = "127.0.0.1";
    const noCorsUrl = new URL("/mock/items/navy-blazer.svg", other).toString();
    await serveImages(page, { missing: ["gone.png"] });
    const noCorsTop = { ...wardrobeItem("top"), originalUrl: noCorsUrl, cutoutUrl: noCorsUrl };
    await fakeRequest(page, {
      status: "ok",
      outfits: [
        outfit([noCorsTop, wardrobeItem("bottom"), wardrobeItem("shoes")], {
          name: "No CORS",
        }),
        outfit([wardrobeItem("top"), wardrobeItem("bottom", { original: "gone.png" }), wardrobeItem("shoes")], { name: "Missing" }),
      ],
    });
    await page.goto("/outfits");
    await askFor(page);
    for (let i = 0; i < 2; i++) {
      const card = cards(page).nth(i);
      const canvas = card.getByTestId("outfit-collage");
      await expect(canvas).toHaveAttribute("data-state", "partial");
      await expect(card.getByText("Some pictures couldn't load.")).toBeVisible();
      // crossOrigin="anonymous" means a non-CORS image fails to load rather
      // than tainting the canvas, so the canvas can still be exported...
      expect(await exportCollage(canvas)).toBeGreaterThan(1000);
      // ...but "Save image" waits for a complete collage (review decision),
      // and "Reload pictures" is offered instead.
      await expect(card.getByRole("button", { name: /^Save image of / })).toBeDisabled();
      await expect(card.getByRole("button", { name: "Reload pictures" })).toBeVisible();
    }
  });
});

// ---------------------------------------------------------------------------
// Request form
// ---------------------------------------------------------------------------

test.describe("request form", () => {
  test("custom style: limited to 100 characters, and blank text is refused without a request", async ({ page }) => {
    let posted = 0;
    page.on("request", (r) => {
      if (r.method() === "POST" && new URL(r.url()).pathname === "/api/outfits") posted++;
    });
    await page.goto("/outfits");
    await tapRadio(page, "Something else");
    const input = page.getByLabel("Describe the occasion");
    await expect(input).toBeFocused();
    await input.fill("x".repeat(130));
    await expect(input).toHaveValue("x".repeat(100));

    await input.fill("    ");
    await page.getByRole("button", { name: "Get outfits" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Say what you're dressing for." })).toBeVisible();
    await expect(input).toHaveAttribute("aria-invalid", "true");
    expect(posted).toBe(0);

    // Typing clears the error.
    await input.fill("a");
    await expect(page.getByText("Say what you're dressing for.")).toHaveCount(0);
  });

  // QA finding, fixed: the custom-style and guidance error messages are now
  // tied to their fields with aria-describedby.
  test("the custom-style error is linked to its field", async ({ page }) => {
    await page.goto("/outfits");
    await tapRadio(page, "Something else");
    await page.getByRole("button", { name: "Get outfits" }).click();
    await expect(page.getByLabel("Describe the occasion")).toHaveAccessibleDescription("Say what you're dressing for.", {
      timeout: 1000,
    });
  });

  test("guidance: limited to 200 characters with a counter; pasted lines are sent as one", async ({ page }) => {
    await fakeRequest(page, { status: "ok", outfits: [basicOutfit()] });
    await page.goto("/outfits");
    const guidance = page.getByLabel("Anything else? (optional)");
    await guidance.fill("g".repeat(250));
    await expect(guidance).toHaveValue("g".repeat(200));
    await expect(page.getByText("200/200")).toBeVisible();

    await guidance.fill("no heels\nuse my   green dress");
    await tapRadio(page, "Holiday");
    await tapRadio(page, "5 outfits");
    const sent = page.waitForRequest((r) => r.method() === "POST" && new URL(r.url()).pathname === "/api/outfits");
    await page.getByRole("button", { name: "Get outfits" }).click();
    expect((await sent).postDataJSON()).toEqual({
      style: { kind: "preset", presetId: "holiday" },
      guidance: "no heels use my green dress",
      count: 5,
    });
  });

  test("only 3, 4 and 5 are offered as counts", async ({ page }) => {
    await page.goto("/outfits");
    const counts = page.getByRole("group", { name: "How many ideas?" }).getByRole("radio");
    await expect(counts).toHaveCount(3);
    expect(await counts.evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value))).toEqual(["3", "4", "5"]);
  });

  test("keyboard: tab into the styles, arrow to choose, and submit with Enter", async ({ page }) => {
    await fakeRequest(page, { status: "ok", outfits: [basicOutfit()] });
    await page.goto("/outfits");
    // Tab from the top of the page until a style radio has focus.
    let reached = false;
    for (let i = 0; i < 6 && !reached; i++) {
      await page.keyboard.press("Tab");
      reached = await page.evaluate(() => (document.activeElement as HTMLInputElement | null)?.name === "style");
    }
    expect(reached).toBe(true);
    await page.keyboard.press("ArrowRight");
    const checked = page.locator("input[name=style]:checked");
    await expect(checked).toHaveCount(1);
    // The focused chip shows a focus ring (has-focus-visible).
    const ring = await checked.evaluate((el) => getComputedStyle(el.closest("label")!).boxShadow);
    expect(ring).not.toBe("none");

    await page.getByRole("button", { name: "Get outfits" }).focus();
    const sent = page.waitForRequest((r) => r.method() === "POST" && new URL(r.url()).pathname === "/api/outfits");
    await page.keyboard.press("Enter");
    await sent;
    await expect(cards(page)).toHaveCount(1);
  });

  test("every form control has an accessible name, and buttons are real buttons", async ({ page }) => {
    await page.goto(`/outfits?anchor=${NAVY_BLAZER_ID}`);
    await expect(page.getByTestId("anchor-item")).toBeVisible();
    await tapRadio(page, "Something else");
    const unnamed = await page.evaluate(() => {
      const problems: string[] = [];
      for (const el of document.querySelectorAll("main input, main textarea, main button, main a")) {
        const e = el as HTMLElement;
        const labelled =
          e.getAttribute("aria-label") ||
          (e.id && document.querySelector(`label[for="${e.id}"]`)) ||
          e.closest("label") ||
          (e.tagName !== "INPUT" && e.tagName !== "TEXTAREA" && e.innerText.trim());
        if (!labelled) problems.push(e.outerHTML.slice(0, 80));
      }
      // Nothing clickable that isn't a button, link or form control.
      for (const el of document.querySelectorAll("main [onclick], main div[tabindex], main span[tabindex]")) {
        problems.push(`non-button clickable: ${(el as HTMLElement).outerHTML.slice(0, 80)}`);
      }
      return problems;
    });
    expect(unnamed).toEqual([]);
    await expect(page.getByRole("group", { name: "What are you dressing for?" })).toBeVisible();
  });

  test("Get outfits waits while the anchor item is still loading", async ({ page }) => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    await page.route(`**/api/items/${NAVY_BLAZER_ID}`, async (route) => {
      await gate;
      await route.fallback();
    });
    await page.goto(`/outfits?anchor=${NAVY_BLAZER_ID}`);
    await expect(page.getByRole("button", { name: "Get outfits" })).toBeDisabled();
    release();
    await expect(page.getByTestId("anchor-item")).toBeVisible();
    await expect(page.getByRole("button", { name: "Get outfits" })).toBeEnabled();
  });

  test("an unknown anchor is dropped from the request", async ({ page }) => {
    await fakeRequest(page, { status: "ok", outfits: [basicOutfit()] });
    await page.goto(`/outfits?anchor=${UNKNOWN_ID}`);
    await expect(page.getByRole("status").filter({ hasText: "isn't in your wardrobe any more" })).toBeVisible();
    await tapRadio(page, "Work");
    const sent = page.waitForRequest((r) => r.method() === "POST" && new URL(r.url()).pathname === "/api/outfits");
    await page.getByRole("button", { name: "Get outfits" }).click();
    expect((await sent).postDataJSON()).not.toHaveProperty("anchorItemId");
  });

  test("a malformed anchor is ignored: no lookup and no message", async ({ page }) => {
    let lookedUp = false;
    page.on("request", (r) => {
      if (/\/api\/items\//.test(r.url())) lookedUp = true;
    });
    await page.goto("/outfits?anchor=../../etc");
    await expect(page.getByRole("heading", { name: "Outfit ideas" })).toBeVisible();
    await expect(page.getByTestId("anchor-item")).toHaveCount(0);
    await expect(page.getByText("isn't in your wardrobe")).toHaveCount(0);
    expect(lookedUp).toBe(false);
  });

  test("an anchor deleted after the form loaded: the 404 is explained", async ({ page }) => {
    await fakeRequest(page, { error: { code: "not_found", message: "That item wasn't found" } }, 404);
    await page.goto(`/outfits?anchor=${NAVY_BLAZER_ID}`);
    await expect(page.getByTestId("anchor-item")).toBeVisible();
    await askFor(page, "Work");
    const error = page.getByTestId("api-error");
    await expect(error).toHaveAttribute("data-code", "not_found");
    await expect(error).toContainText("That item wasn't found");
  });
});

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

test.describe("results", () => {
  test("save, like and reject: one status at a time, toggling off, cancel and undo", async ({ page }) => {
    await serveImages(page);
    const outfits = [basicOutfit("First"), basicOutfit("Second")];
    await fakeRequest(page, { status: "ok", outfits });
    const sent = await fakeStatusChanges(page, outfits);
    await page.goto("/outfits");
    await askFor(page);
    const card = cards(page).first();
    const button = (name: string) => card.getByRole("button", { name, exact: true });

    await button("Save").click();
    await expect(button("Saved")).toHaveAttribute("aria-pressed", "true");
    await button("Like").click();
    await expect(button("Liked")).toHaveAttribute("aria-pressed", "true");
    await expect(button("Save")).toHaveAttribute("aria-pressed", "false");
    await button("Liked").click();
    await expect(button("Like")).toHaveAttribute("aria-pressed", "false");
    await expect(card).toHaveAttribute("data-status", "suggested");

    // Cancel and Escape close the reject dialog without sending anything.
    await button("Reject").click();
    await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await button("Reject").click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // The reason is capped at 200 characters and sent as one line.
    await button("Reject").click();
    const reason = page.getByRole("dialog").getByLabel("Why not? (optional)");
    await reason.fill("r".repeat(220));
    await expect(reason).toHaveValue("r".repeat(200));
    await reason.fill("too\nbright");
    await page.getByRole("dialog").getByRole("button", { name: "Reject outfit" }).click();
    await expect(card).toHaveAttribute("data-status", "rejected");
    await card.getByRole("button", { name: "Undo" }).click();
    await expect(card).toHaveAttribute("data-status", "suggested");

    expect(sent).toEqual([
      { status: "saved" },
      { status: "liked" },
      { status: "suggested" },
      { status: "rejected", reason: "too bright" },
      { status: "suggested" },
    ]);
  });

  // QA finding, fixed: closing the reject dialog (Escape or Cancel) now
  // returns focus to the Reject button.
  test("closing the reject dialog returns focus to Reject", async ({ page }) => {
    await serveImages(page);
    await fakeRequest(page, { status: "ok", outfits: [basicOutfit("Focus")] });
    await page.goto("/outfits");
    await askFor(page);
    const reject = cards(page).first().getByRole("button", { name: "Reject", exact: true });
    await reject.click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(reject).toBeFocused({ timeout: 2000 });
  });

  test("a failed status change keeps the old status and says so", async ({ page }) => {
    await serveImages(page);
    const outfits = [basicOutfit("Keeps status")];
    await fakeRequest(page, { status: "ok", outfits });
    await fakeStatusChanges(page, outfits, true);
    await page.goto("/outfits");
    await askFor(page);
    const card = cards(page).first();
    await card.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByTestId("api-error")).toContainText("Database unavailable");
    await expect(card).toHaveAttribute("data-status", "suggested");
    await expect(card.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
  });

  test("refine: ai_failed keeps the outfits, Try again works; buttons wait while a refine runs", async ({ page }) => {
    await serveImages(page);
    const first = [basicOutfit("Original one"), basicOutfit("Original two")];
    const revised = [basicOutfit("Revised one")];
    await fakeRequest(page, { status: "ok", outfits: first });
    let calls = 0;
    let release: () => void = () => {};
    await page.route(/\/api\/outfits\/[^/]+\/refine$/, async (route) => {
      calls++;
      if (calls === 1) {
        await route.fulfill({ status: 502, json: { error: { code: "ai_failed", message: "The model failed twice." } } });
        return;
      }
      await new Promise<void>((resolve) => (release = resolve));
      await route.fulfill({ json: { status: "ok", outfits: revised } });
    });
    await page.goto("/outfits");
    await askFor(page);
    const firstCard = cards(page).first();
    await firstCard.getByRole("button", { name: "Tweak this outfit" }).click();
    await firstCard.getByRole("button", { name: "Warmer" }).click();

    const error = page.getByTestId("api-error");
    await expect(error).toHaveAttribute("data-code", "ai_failed");
    await expect(error).toContainText("We couldn't put outfits together");
    await expect(cards(page)).toHaveCount(2);
    await expect(page.getByRole("heading", { name: "Outfits for Casual" })).toBeVisible();

    await error.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByRole("status")).toContainText("Working on it: tweaked: warmer");
    // While it runs, no second refine can start.
    await expect(firstCard.getByRole("button", { name: "Cooler" })).toBeDisabled();
    await expect(cards(page).nth(1).getByRole("button", { name: /^Swap / }).first()).toBeDisabled();
    release();
    await expect(page.getByRole("heading", { name: "Tweaked: warmer" })).toBeVisible();
    await expect(page.getByTestId("api-error")).toHaveCount(0);
    await expect(cards(page)).toHaveCount(1);
  });

  test("refine: ai_paused on guidance keeps the outfits", async ({ page }) => {
    await serveImages(page);
    const outfits = [basicOutfit("Stays put")];
    await fakeRequest(page, { status: "ok", outfits });
    await page.route(/\/refine$/, (route) =>
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
    await page.goto("/outfits");
    await askFor(page);
    await cards(page).first().getByRole("button", { name: "Tweak this outfit" }).click();
    await cards(page).first().getByPlaceholder("Or say what to change").fill("less formal");
    await cards(page).first().getByRole("button", { name: "Update" }).click();
    const error = page.getByTestId("api-error");
    await expect(error).toHaveAttribute("data-code", "ai_paused");
    await expect(error).toContainText("until Sun 1 Nov, 00:00");
    await expect(error.getByRole("button", { name: "Try again" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Stays put" })).toBeVisible();
  });

  test("refine that leaves the wardrobe short shows the missing category, and Back still works", async ({ page }) => {
    await serveImages(page);
    await fakeRequest(page, { status: "ok", outfits: [basicOutfit("Only shoes")] });
    await page.route(/\/refine$/, (route) =>
      route.fulfill({
        json: {
          status: "incomplete_wardrobe",
          reason: "missing_category",
          missingCategories: ["shoes"],
          message: "Add shoes to your wardrobe to get outfits.",
        },
      }),
    );
    await page.goto("/outfits");
    await askFor(page);
    await cards(page).first().getByRole("button", { name: "Swap Test shoes" }).click();
    const notice = page.getByTestId("incomplete-wardrobe");
    await expect(notice).toHaveAttribute("data-reason", "missing_category");
    await expect(notice.getByRole("link", { name: "Add shoes" })).toHaveAttribute("href", "/add");
    await page.getByRole("button", { name: "Back to previous ideas" }).click();
    await expect(page.getByRole("heading", { name: "Only shoes" })).toBeVisible();
    await expect(page.getByTestId("incomplete-wardrobe")).toHaveCount(0);
  });

  test("two refines, then Back twice; feedback given earlier is kept", async ({ page }) => {
    await serveImages(page);
    const sets = [[basicOutfit("Set A")], [basicOutfit("Set B")], [basicOutfit("Set C")]];
    const all = sets.flat();
    await fakeRequest(page, { status: "ok", outfits: sets[0] });
    await fakeStatusChanges(page, all);
    let n = 0;
    await page.route(/\/refine$/, (route) => route.fulfill({ json: { status: "ok", outfits: sets[++n] } }));
    await page.goto("/outfits");
    await askFor(page);
    await cards(page).first().getByRole("button", { name: "Save", exact: true }).click();
    await expect(cards(page).first()).toHaveAttribute("data-status", "saved");

    await cards(page).first().getByRole("button", { name: "Swap Test top" }).click();
    await expect(page.getByRole("heading", { name: "Set B" })).toBeVisible();
    await cards(page).first().getByRole("button", { name: "Tweak this outfit" }).click();
    await cards(page).first().getByRole("button", { name: "Smarter" }).click();
    await expect(page.getByRole("heading", { name: "Set C" })).toBeVisible();
    await expect(page.getByText("New ideas based on Set B")).toBeVisible();

    await page.getByRole("button", { name: "Back to previous ideas" }).click();
    await expect(page.getByRole("heading", { name: "Set B" })).toBeVisible();
    await page.getByRole("button", { name: "Back to previous ideas" }).click();
    await expect(page.getByRole("heading", { name: "Set A" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Back to previous ideas" })).toHaveCount(0);
    await expect(cards(page).first()).toHaveAttribute("data-status", "saved");
  });

  test("a real swap and guidance refine against the mock API replace the set", async ({ page }) => {
    // Uses 3 of the mock user's daily outfit requests.
    await page.goto("/outfits");
    await askFor(page, "Comfy");
    await expect(cards(page).first()).toBeVisible();
    const before = await cards(page).evaluateAll((els) => els.map((e) => e.getAttribute("data-outfit-id")));
    const swap = cards(page).first().getByRole("button", { name: /^Swap / }).first();
    await swap.click();
    await expect(page.getByRole("heading", { name: /^Swapped out the / })).toBeVisible();
    const after = await cards(page).evaluateAll((els) => els.map((e) => e.getAttribute("data-outfit-id")));
    expect(after.some((id) => before.includes(id))).toBe(false);
    // Revised outfits are new outfits whose parent is the refined one.
    const parent = await page.request.get(`/api/outfits/${after[0]}`);
    expect((await parent.json()).outfit.parentOutfitId).toBe(before[0]);

    await cards(page).first().getByRole("button", { name: "Tweak this outfit" }).click();
    await cards(page).first().getByRole("button", { name: "Less formal" }).click();
    await expect(page.getByRole("heading", { name: "Tweaked: less formal" })).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Error and incomplete-wardrobe copy
// ---------------------------------------------------------------------------

test.describe("error copy", () => {
  test("missing_category around an anchor names the one category to add", async ({ page }) => {
    await fakeRequest(page, {
      status: "incomplete_wardrobe",
      reason: "missing_category",
      missingCategories: ["bottom"],
      message: "Add bottom to your wardrobe to get outfits.",
    });
    await page.goto(`/outfits?anchor=${NAVY_BLAZER_ID}`);
    await expect(page.getByTestId("anchor-item")).toBeVisible();
    await askFor(page, "Work");
    const notice = page.getByTestId("incomplete-wardrobe");
    await expect(notice.getByRole("heading", { name: "Your wardrobe needs a few more pieces" })).toBeVisible();
    await expect(notice.getByRole("listitem")).toHaveCount(1);
    await expect(notice.getByRole("link", { name: "Add trousers, jeans or a skirt" })).toHaveAttribute("href", "/add");
    await expectTapTargets(notice, "missing_category notice");
  });

  test("each error's copy, at 390 px with no sideways scroll", async ({ page }) => {
    const cases = [
      {
        status: 503,
        error: { code: "ai_paused", message: "x", cap: { kind: "monthly_ai_spend", limit: 500, resetsAt: "2026-11-01T00:00:00.000Z" } },
        title: "Outfit ideas are paused for now",
        retry: false,
        savedLink: true,
      },
      {
        status: 429,
        error: { code: "daily_cap_reached", message: "x", cap: { kind: "outfit_requests_per_day", limit: 25, resetsAt: "2026-10-26T00:00:00.000Z" } },
        title: "That's today's outfit ideas used up",
        retry: false,
        savedLink: true,
      },
      { status: 502, error: { code: "ai_failed", message: "x" }, title: "We couldn't put outfits together", retry: true, savedLink: false },
      { status: 401, error: { code: "unauthorized", message: "x" }, title: "You're signed out", retry: false, savedLink: false },
      { status: 500, error: { code: "internal", message: "Boom" }, title: "Something went wrong", retry: true, savedLink: false },
    ];
    let current = cases[0]!;
    await page.route(/\/api\/outfits$/, (route) => route.fulfill({ status: current.status, json: { error: current.error } }));
    await page.goto("/outfits");
    await tapRadio(page, "Casual");
    for (const c of cases) {
      current = c;
      await page.getByRole("button", { name: "Get outfits" }).click();
      const error = page.getByTestId("api-error");
      await expect(error).toHaveAttribute("data-code", c.error.code);
      await expect(error).toContainText(c.title);
      await expect(error.getByRole("button", { name: "Try again" })).toHaveCount(c.retry ? 1 : 0);
      await expect(error.getByRole("link", { name: "See saved outfits" })).toHaveCount(c.savedLink ? 1 : 0);
      await expectNoSidewaysScroll(page, `${c.error.code} error`);
      await expectTapTargets(page.locator("main"), `${c.error.code} error`);
      await page.getByRole("button", { name: "Change request" }).click();
    }
  });

  test("ai_paused on the very first request (mock marker in a custom style)", async ({ page }) => {
    await page.goto("/outfits");
    await tapRadio(page, "Something else");
    await page.getByLabel("Describe the occasion").fill("gala mock-ai-paused");
    await page.getByRole("button", { name: "Get outfits" }).click();
    await expect(page.getByTestId("api-error")).toHaveAttribute("data-code", "ai_paused");
    await page.getByRole("link", { name: "See saved outfits" }).click();
    await expect(page).toHaveURL(/\/outfits\/saved$/);
  });
});

// ---------------------------------------------------------------------------
// Saved screen
// ---------------------------------------------------------------------------

test.describe("saved screen", () => {
  function fakeSaved(page: Page, outfits: Outfit[]) {
    return page.route(/\/api\/outfits\?status=/, (route) => {
      const status = new URL(route.request().url()).searchParams.get("status");
      return route.fulfill({ json: { outfits: outfits.filter((o) => o.status === status) } });
    });
  }

  test("All, Saved and Liked filters; newest first; an empty filter explains itself", async ({ page }) => {
    await serveImages(page);
    const outfits = [
      outfit([wardrobeItem("top"), wardrobeItem("bottom"), wardrobeItem("shoes")], { name: "Old saved", status: "saved", createdAt: "2026-10-20T10:00:00.000Z" }),
      outfit([wardrobeItem("dress_jumpsuit"), wardrobeItem("shoes")], { name: "New liked", status: "liked", createdAt: "2026-10-24T10:00:00.000Z" }),
      outfit([wardrobeItem("top"), wardrobeItem("bottom"), wardrobeItem("shoes")], { name: "Mid saved", status: "saved", createdAt: "2026-10-22T10:00:00.000Z" }),
    ];
    await fakeSaved(page, outfits);
    await page.goto("/outfits/saved");
    const names = () => cards(page).getByRole("heading", { level: 2 }).allInnerTexts();
    await expect(cards(page)).toHaveCount(3);
    expect(await names()).toEqual(["New liked", "Mid saved", "Old saved"]);
    await expect(page.getByRole("radio", { name: "All" })).toHaveAttribute("aria-checked", "true");

    await page.getByRole("radio", { name: "Saved" }).click();
    await expect(page.getByRole("radio", { name: "Saved" })).toHaveAttribute("aria-checked", "true");
    await expect(cards(page)).toHaveCount(2);
    expect(await names()).toEqual(["Mid saved", "Old saved"]);

    await page.getByRole("radio", { name: "Liked" }).click();
    expect(await names()).toEqual(["New liked"]);
    await expectTapTargets(page.locator("main"), "saved screen");
    await expectNoSidewaysScroll(page, "saved screen");
  });

  test("a filter with nothing in it says so", async ({ page }) => {
    await serveImages(page);
    await fakeSaved(page, [basicOutfit("Saved only")].map((o) => ({ ...o, status: "saved" })));
    await page.goto("/outfits/saved");
    await page.getByRole("radio", { name: "Liked" }).click();
    await expect(page.getByText("No liked outfits yet.")).toBeVisible();
  });

  // QA finding, fixed: the filter now uses the status set on this screen.
  test("an outfit changed from liked to saved here shows under the Saved filter", async ({ page }) => {
    await serveImages(page);
    const outfits = [outfit([wardrobeItem("top"), wardrobeItem("bottom"), wardrobeItem("shoes")], { name: "Was liked", status: "liked" })];
    await fakeSaved(page, outfits);
    await fakeStatusChanges(page, outfits);
    await page.goto("/outfits/saved");
    await cards(page).first().getByRole("button", { name: "Save", exact: true }).click();
    await expect(cards(page).first()).toHaveAttribute("data-status", "saved");
    await page.getByRole("radio", { name: "Saved" }).click();
    await expect(page.getByText("Was liked")).toBeVisible({ timeout: 2000 });
  });

  test("un-saving keeps the card in place until the screen is reopened", async ({ page }) => {
    await serveImages(page);
    const outfits = [outfit([wardrobeItem("top"), wardrobeItem("bottom"), wardrobeItem("shoes")], { name: "Unsave me", status: "saved" })];
    await fakeSaved(page, outfits);
    const sent = await fakeStatusChanges(page, outfits);
    await page.goto("/outfits/saved");
    await cards(page).first().getByRole("button", { name: "Saved", exact: true }).click();
    await expect(cards(page).first()).toHaveAttribute("data-status", "suggested");
    expect(sent).toEqual([{ status: "suggested" }]);
    await page.reload();
    await expect(page.getByTestId("saved-empty")).toBeVisible();
  });

  test("a load failure offers Try again, which reloads", async ({ page }) => {
    let fail = true;
    await page.route(/\/api\/outfits\?status=/, (route) =>
      fail
        ? route.fulfill({ status: 500, json: { error: { code: "internal", message: "Database unavailable" } } })
        : route.fulfill({ json: { outfits: [] } }),
    );
    await page.goto("/outfits/saved");
    const error = page.getByTestId("api-error");
    await expect(error).toContainText("Database unavailable");
    fail = false;
    await error.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByTestId("saved-empty")).toBeVisible();
    await expectNoSidewaysScroll(page, "saved empty");
    await expectTapTargets(page.locator("main"), "saved empty");
  });
});

// ---------------------------------------------------------------------------
// Mobile: sideways scroll and tap targets on every screen and state
// ---------------------------------------------------------------------------

test.describe("mobile at 390 px", () => {
  test("request screen states: anchor, missing anchor, custom style and errors", async ({ page }) => {
    await page.goto(`/outfits?anchor=${NAVY_BLAZER_ID}`);
    await expect(page.getByTestId("anchor-item")).toBeVisible();
    await expectNoSidewaysScroll(page, "request with anchor");
    await expectTapTargets(page.locator("main"), "request with anchor");

    await page.goto(`/outfits?anchor=${UNKNOWN_ID}`);
    await expect(page.getByText("isn't in your wardrobe any more")).toBeVisible();
    await expectNoSidewaysScroll(page, "request with missing anchor");

    await page.goto("/outfits");
    await tapRadio(page, "Something else");
    await page.getByRole("button", { name: "Get outfits" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Say what" })).toBeVisible();
    await expectNoSidewaysScroll(page, "request with an error");
  });

  test("results: long names and descriptions, tweak open, reject dialog, after a refine", async ({ page }) => {
    await serveImages(page);
    const long = outfit(
      [
        wardrobeItem("top", { description: "Oversized heavyweight organic cotton crew-neck t-shirt with dropped shoulders and a boxy fit for layering" }),
        wardrobeItem("bottom", { description: "Wide-leg high-waisted pleated wool-blend trousers" }),
        wardrobeItem("shoes", { description: "Chunky leather loafers" }),
        wardrobeItem("outerwear", { description: "Camel double-breasted wool overcoat" }),
      ],
      { name: "Weekend in the city with a light jacket" },
    );
    const outfits = [long, basicOutfit("Second")];
    await fakeRequest(page, { status: "ok", outfits });
    await fakeStatusChanges(page, outfits);
    await page.route(/\/refine$/, (route) => route.fulfill({ json: { status: "ok", outfits: [basicOutfit("Revised")] } }));
    await page.goto("/outfits");
    await askFor(page);
    await expect(cards(page)).toHaveCount(2);
    await expectNoSidewaysScroll(page, "results");

    const card = cards(page).first();
    await card.getByRole("button", { name: "Tweak this outfit" }).click();
    await expectNoSidewaysScroll(page, "results with tweak open");
    await expectTapTargets(card, "outfit card with tweak open");
    await expectTapTargets(page.locator("main header"), "results header");

    await card.getByRole("button", { name: "Reject", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    // Let the open animation (a zoom from 95%) finish before measuring.
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"));
    await expectNoSidewaysScroll(page, "reject dialog");
    await expectTapTargets(dialog, "reject dialog");
    const box = await dialog.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    await dialog.getByRole("button", { name: "Reject outfit" }).click();
    // Wait for the card to finish collapsing, or the buttons counted below can
    // vanish before they're measured.
    await expect(card.getByRole("button", { name: /Undo/ })).toBeVisible();
    await expect(dialog).toBeHidden();
    await expectTapTargets(card, "rejected card");

    await cards(page).nth(1).getByRole("button", { name: "Swap Test top" }).click();
    await expect(page.getByRole("heading", { name: "Revised" })).toBeVisible();
    await expectNoSidewaysScroll(page, "refined results");
    await expectTapTargets(page.locator("main"), "refined results");
  });

  test("a long unbroken outfit name (40 characters) doesn't cause sideways scroll", async ({ page }) => {
    await serveImages(page);
    await fakeRequest(page, { status: "ok", outfits: [basicOutfit("Supercalifragilisticexpialidocious-looks")] });
    await page.goto("/outfits");
    await askFor(page);
    await expect(cards(page)).toHaveCount(1);
    await expectNoSidewaysScroll(page, "results with a long unbroken name");
  });
});
