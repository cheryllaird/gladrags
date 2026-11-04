import { readFileSync } from "node:fs";
import { expect, test, type Page, type Route } from "@playwright/test";
import { checkPhoneLayout } from "./phone-layout";

// QA for milestone 5 wardrobe screens (C5) at 390 px, in mock mode:
// adversarial batch photos and links, the review list at scale, drafts in
// sessionStorage, the checklist with storage blocked, and settings failure
// paths. Uploads are answered here where a test needs exact counts, since
// the mock store is shared by tests running in parallel.

const PHOTO = readFileSync(new URL("./fixtures/shirt.jpg", import.meta.url));
const MOCK_USER_ID = "0a000000-0000-4000-8000-000000000001";
const OTHER_USER_ID = "0a000000-0000-4000-8000-000000000002";
const BATCH_DRAFTS_KEY = "gladrags:batch-drafts";

const photo = (name: string) => ({ name, mimeType: "image/jpeg", buffer: PHOTO });

type Item = { id: string; tags: { description: string }; needsReview: boolean; needsPhoto: boolean };

async function anItem(page: Page): Promise<Item> {
  return (await (await page.request.get("/api/items")).json()).items[0];
}

/** Answer every batch photo upload with "saved", counting them. */
async function answerUploads(page: Page, item: Item, handle?: (route: Route, n: number) => Promise<boolean>) {
  const seen = { count: 0 };
  await page.route("**/api/items/photo", async (route) => {
    seen.count++;
    if (handle && (await handle(route, seen.count))) return;
    await route.fulfill({ json: { status: "saved", item: { ...item, needsReview: true } } });
  });
  return seen;
}

const errorJson = (code: string, message: string) => ({ error: { code, message } });

test.describe("batch photos (QA)", () => {
  test("43 photos: 40 are taken, one at a time, and the summary says 3 were left out", async ({ page }) => {
    const item = await anItem(page);
    const seen = await answerUploads(page, item);
    await page.goto("/add");
    await page.getByTestId("photo-library-input").setInputFiles(Array.from({ length: 43 }, (_, i) => photo(`p${i}.jpg`)));
    await expect(page.getByText("All 40 photos added")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText("You can add up to 40 photos at once, so the other 3 weren't included.")).toBeVisible();
    await expect(page.getByRole("list", { name: "Photos" }).getByRole("listitem")).toHaveCount(40);
    expect(seen.count).toBe(40);
    await checkPhoneLayout(page, "40-photo summary");
  });

  test("a HEIC-named photo the browser can decode is uploaded as JPEG", async ({ page }) => {
    const item = await anItem(page);
    const names: string[] = [];
    await answerUploads(page, item, async (route) => {
      names.push(route.request().postDataBuffer()?.toString("latin1").match(/filename="([^"]+)"/)?.[1] ?? "");
      return false;
    });
    await page.goto("/add");
    await page
      .getByTestId("photo-library-input")
      .setInputFiles([{ name: "IMG_0001.HEIC", mimeType: "image/heic", buffer: PHOTO }, photo("b.jpg")]);
    await expect(page.getByText("All 2 photos added")).toBeVisible();
    expect(names).toEqual(["IMG_0001.jpg", "b.jpg"]);
  });

  test("an unreadable file in the middle fails alone and isn't uploaded", async ({ page }) => {
    const item = await anItem(page);
    const seen = await answerUploads(page, item);
    await page.goto("/add");
    await page
      .getByTestId("photo-library-input")
      .setInputFiles([photo("a.jpg"), { name: "broken.jpg", mimeType: "image/jpeg", buffer: Buffer.from("not an image") }, photo("c.jpg")]);
    await expect(page.getByText("1 couldn't be added (see below).")).toBeVisible();
    await expect(page.getByText("2 items are in your wardrobe, marked to review.")).toBeVisible();
    const rows = page.getByRole("list", { name: "Photos" }).getByRole("listitem");
    await expect(rows.nth(1)).toHaveAttribute("data-state", "failed");
    expect(seen.count).toBe(2);
  });

  test("AI paused mid-batch stops it and says so", async ({ page }) => {
    const sent: string[] = [];
    await page.route("**/api/items/photo", async (route) => {
      sent.push(route.request().postDataBuffer()?.toString("latin1").match(/filename="([^"]+)"/)?.[1] ?? "");
      await route.continue();
    });
    await page.goto("/add");
    await page.getByTestId("photo-library-input").setInputFiles([photo("one.jpg"), photo("two-mock-ai-paused.jpg"), photo("three.jpg")]);
    await expect(page.getByText("1 was added before it stopped; the other 2 photos weren't.")).toBeVisible();
    await expect(page.locator("[data-error-kind=paused]")).toBeVisible();
    expect(sent).toEqual(["one.jpg", "two-mock-ai-paused.jpg"]);
  });

  test("going offline mid-batch stops it; nothing more is sent", async ({ page }) => {
    const item = await anItem(page);
    const seen = await answerUploads(page, item, async (route, n) => {
      if (n === 2) {
        await route.abort("internetdisconnected");
        return true;
      }
      return false;
    });
    await page.goto("/add");
    await page.getByTestId("photo-library-input").setInputFiles([photo("a.jpg"), photo("b.jpg"), photo("c.jpg"), photo("d.jpg")]);
    await expect(page.getByText("1 was added before it stopped; the other 3 photos weren't.")).toBeVisible();
    await expect(page.getByText(/Check your connection/)).toBeVisible();
    expect(seen.count).toBe(2);
    // The add-more button still works.
    await page.getByRole("button", { name: "Add more" }).click();
    await expect(page.getByRole("button", { name: "Choose from library" })).toBeVisible();
  });

  test("reloading mid-batch asks first; once finished it doesn't", async ({ page }) => {
    const item = await anItem(page);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await answerUploads(page, item, async (route, n) => {
      if (n === 1) await gate;
      return false;
    });
    await page.goto("/add");
    // A tap first: browsers only ask before unloading after the user has interacted.
    await page.getByText("One item per photo.").click();
    await page.getByTestId("photo-library-input").setInputFiles([photo("a.jpg"), photo("b.jpg")]);
    await expect(page.getByText(/0 of 2 photos done/)).toBeVisible();

    const dialogs: string[] = [];
    page.once("dialog", async (dialog) => {
      dialogs.push(dialog.type());
      await dialog.dismiss(); // Stay on the page.
    });
    await page.reload({ timeout: 3_000 }).catch(() => {});
    expect(dialogs).toEqual(["beforeunload"]);

    release();
    await expect(page.getByText("All 2 photos added")).toBeVisible();
    page.on("dialog", (dialog) => {
      dialogs.push(`after:${dialog.type()}`);
      void dialog.accept();
    });
    await page.reload();
    expect(dialogs).toEqual(["beforeunload"]);
  });

  test("a session that expires mid-batch goes to sign-in without a 'leave page?' prompt", async ({ page }) => {
    // Known bug, reported: the beforeunload guard is still attached when
    // api.ts redirects to sign-in, so the browser asks "Leave site?"; "Stay"
    // leaves the user on a dead page.
    test.fail();
    const item = await anItem(page);
    await answerUploads(page, item, async (route, n) => {
      if (n === 2) {
        await route.fulfill({ status: 401, json: errorJson("unauthorized", "Sign in again.") });
        return true;
      }
      return false;
    });
    const dialogs: string[] = [];
    page.on("dialog", (dialog) => {
      dialogs.push(dialog.type());
      void dialog.accept();
    });
    await page.goto("/add");
    await page.getByText("One item per photo.").click();
    await page.getByTestId("photo-library-input").setInputFiles([photo("a.jpg"), photo("b.jpg"), photo("c.jpg")]);
    await page.waitForURL(/\/sign-in|\/wardrobe/, { timeout: 15_000 });
    expect(dialogs).toEqual([]);
  });

  test("leaving by the bottom nav mid-batch: the wardrobe opens and nothing breaks", async ({ page }) => {
    const item = await anItem(page);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const seen = await answerUploads(page, item, async (_route, n) => {
      if (n === 1) await gate;
      return false;
    });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/add");
    await page.getByTestId("photo-library-input").setInputFiles([photo("a.jpg"), photo("b.jpg"), photo("c.jpg")]);
    await expect(page.getByText(/0 of 3 photos done/)).toBeVisible();
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Wardrobe" }).click();
    await expect(page).toHaveURL(/\/wardrobe/);
    release();
    // The batch carries on in the background (recorded behaviour; reported as no warning on in-app navigation).
    await expect.poll(() => seen.count).toBe(3);
    expect(errors).toEqual([]);
  });

  test("with session storage blocked, a draft still shows in the summary", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, "sessionStorage", {
        get() {
          throw new DOMException("blocked", "SecurityError");
        },
      });
    });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/add");
    await page.getByTestId("photo-library-input").setInputFiles([photo("fine.jpg"), photo("x-mock-no-tags.jpg")]);
    await expect(page.getByText("1 couldn't be tagged automatically: fill in the tags in the review list.")).toBeVisible();
    expect(errors).toEqual([]);
  });
});

test.describe("batch links (QA)", () => {
  test("only http(s) links are sent; other schemes and duplicates are dropped", async ({ page }) => {
    const sent: string[] = [];
    await page.route("**/api/items/link", async (route) => {
      sent.push(route.request().postDataJSON().url);
      await route.fulfill({
        json: { status: "needs_screenshot", reason: "fetch_blocked", sourceUrl: route.request().postDataJSON().url, message: "Blocked." },
      });
    });
    const stamp = Date.now();
    const a = `https://shop.example.com/p/a-${stamp}?utm_source=email&utm_medium=x`;
    const b = `https://shop.example.com/p/b-${stamp}`;
    await page.goto("/add/link");
    await page
      .getByLabel("Product links")
      .fill(
        [
          "javascript:alert(document.cookie)",
          "data:text/html,<script>alert(1)</script>",
          "file:///etc/passwd",
          "ftp://shop.example.com/x",
          `Here: ${a}.`,
          `[again](${a})`,
          `(${b})!`,
          b,
        ].join("\n"),
      );
    await expect(page.getByText("2 different links found.")).toBeVisible();
    await page.getByRole("button", { name: "Add 2 links" }).click();
    await expect(page.getByText("2 links need a screenshot: the site couldn't be read. Add them below.")).toBeVisible();
    expect(sent).toEqual([a, b]);
  });

  test("only non-links: says to paste a full link and sends nothing", async ({ page }) => {
    let calls = 0;
    await page.route("**/api/items/link", async (route) => {
      calls++;
      await route.continue();
    });
    await page.goto("/add/link");
    await page.getByLabel("Product links").fill("javascript:alert(1)\nfile:///etc/passwd\nwww.next.co.uk/p");
    await page.getByRole("button", { name: "Add from link" }).click();
    await expect(page.getByText("Paste a full link starting with https://")).toBeVisible();
    expect(calls).toBe(0);
  });

  test("1,000 pasted links: the first 40 are imported and the rest are counted", async ({ page }) => {
    const sent: string[] = [];
    await page.route("**/api/items/link", async (route) => {
      sent.push(route.request().postDataJSON().url);
      await route.fulfill({
        json: { status: "needs_screenshot", reason: "no_product_data", sourceUrl: route.request().postDataJSON().url, message: "No data." },
      });
    });
    await page.goto("/add/link");
    const text = Array.from({ length: 1000 }, (_, i) => `https://shop.example.com/p/${i}`).join("\n");
    await page.getByLabel("Product links").fill(text);
    await expect(page.getByText("40 different links found (the first 40; add the other 960 in another go).")).toBeVisible();
    await checkPhoneLayout(page, "1,000 links pasted");
    await page.getByRole("button", { name: "Add 40 links" }).click();
    await expect(page.getByText("You can add up to 40 links at once, so the other 960 weren't included.")).toBeVisible();
    await expect(page.getByText("40 links need a screenshot", { exact: false })).toBeVisible({ timeout: 60_000 });
    expect(sent).toHaveLength(40);
    expect(sent[39]).toBe("https://shop.example.com/p/39");
  });

  test("a screenshot that hits the cap leaves the row waiting with the reason, and can be retried", async ({ page }) => {
    const blocked = `https://blocked.example.com/p/${Date.now()}`;
    await page.goto("/add/link");
    await page.getByLabel("Product links").fill(`${blocked}\nhttps://shop.example.com/p/ok-${Date.now()}`);
    await page.getByRole("button", { name: "Add 2 links" }).click();
    const row = page.getByRole("list", { name: "Links" }).getByRole("listitem").filter({ hasText: "blocked.example.com" });
    await expect(row.getByRole("button", { name: "Add a screenshot" })).toBeVisible();

    await row.getByTestId("screenshot-input").setInputFiles(photo("shot-mock-daily-cap.jpg"));
    await expect(row).toHaveAttribute("data-state", "needs_screenshot");
    await expect(row).toContainText(/today/i);
    await row.getByTestId("screenshot-input").setInputFiles(photo("shot.jpg"));
    await expect(row).toHaveAttribute("data-state", "saved");
    await expect(page.getByText("All 2 links added")).toBeVisible();
  });

  test("AI paused at step 2 stops a link batch", async ({ page }) => {
    const stamp = Date.now();
    await page.goto("/add/link");
    await page
      .getByLabel("Product links")
      .fill(`https://shop.example.com/p/1-${stamp}\nhttps://shop.example.com/p/2?x=mock-ai-paused\nhttps://shop.example.com/p/3-${stamp}`);
    await page.getByRole("button", { name: "Add 3 links" }).click();
    await expect(page.getByText("1 was added before it stopped; the other 2 links weren't.")).toBeVisible();
    await expect(page.locator("[data-error-kind=paused]")).toBeVisible();
  });
});

test.describe("review list (QA)", () => {
  test("Confirm all with 150 items sends two requests of at most 100; the banner follows", async ({ page }) => {
    const base = await anItem(page);
    const items = Array.from({ length: 150 }, (_, i) => ({
      ...base,
      id: `0a000000-0000-4000-8000-${String(900000 + i).padStart(12, "0")}`,
      needsReview: true,
      tags: { ...base.tags, description: `QA item ${i + 1}` },
    }));
    let waiting = items;
    const chunks: string[][] = [];
    await page.route(
      (url) => url.pathname === "/api/items" && url.searchParams.get("needsReview") === "true",
      (route) => route.fulfill({ json: { items: waiting } }),
    );
    await page.route("**/api/items/reviewed", async (route) => {
      const ids = route.request().postDataJSON().itemIds as string[];
      chunks.push(ids);
      waiting = waiting.filter((i) => !ids.includes(i.id));
      await route.fulfill({ json: { updated: ids.length } });
    });

    await page.goto("/wardrobe");
    await page.getByRole("link", { name: /Review 150 new items/ }).click();
    await expect(page.getByRole("heading", { name: "To review (150)" })).toBeVisible();
    await page.getByRole("button", { name: "Confirm all 150" }).click();
    await expect(page.getByText("All caught up")).toBeVisible();
    expect(chunks.map((c) => c.length)).toEqual([100, 50]);

    await page.getByRole("link", { name: "Back to wardrobe" }).first().click();
    await expect(page.getByRole("heading", { name: "Wardrobe" })).toBeVisible();
    await expect(page.getByRole("link", { name: /new item/ })).toHaveCount(0);
  });

  test("another user's batch drafts left in the tab are cleared and never shown", async ({ page }) => {
    await page.route(
      (url) => url.pathname === "/api/items" && url.searchParams.get("needsReview") === "true",
      (route) => route.fulfill({ json: { items: [] } }),
    );
    await page.goto("/wardrobe");
    await page.evaluate(
      ({ key, other }) => {
        window.sessionStorage.setItem("gladrags:user", other);
        window.sessionStorage.setItem(
          key,
          JSON.stringify({
            userId: other,
            drafts: [
              {
                draft: {
                  source: "photo",
                  sourceUrl: null,
                  originalImageKey: `${other}/1b000000-0000-4000-8000-000000000001.jpg`,
                  cutoutImageKey: null,
                  originalUrl: "/mock/items/uploaded.svg",
                  cutoutUrl: null,
                  suggestedTags: null,
                },
                addedAt: Date.now(),
              },
            ],
          }),
        );
      },
      { key: BATCH_DRAFTS_KEY, other: OTHER_USER_ID },
    );
    await page.goto("/wardrobe/review");
    await expect(page.getByText("All caught up")).toBeVisible();
    await expect(page.getByRole("heading", { name: /Need tags/ })).toHaveCount(0);
    expect(await page.evaluate((key) => window.sessionStorage.getItem(key), BATCH_DRAFTS_KEY)).toBeNull();
    expect(await page.evaluate(() => window.sessionStorage.getItem("gladrags:user"))).toBe(MOCK_USER_ID);
  });

  test("expired drafts aren't shown or counted in the banner", async ({ page }) => {
    await page.route(
      (url) => url.pathname === "/api/items" && url.searchParams.get("needsReview") === "true",
      (route) => route.fulfill({ json: { items: [] } }),
    );
    await page.goto("/wardrobe");
    await page.evaluate(
      ({ key, user }) => {
        const draft = (n: number) => ({
          source: "photo",
          sourceUrl: null,
          originalImageKey: `${user}/1b000000-0000-4000-8000-00000000000${n}.jpg`,
          cutoutImageKey: null,
          originalUrl: "/mock/items/uploaded.svg",
          cutoutUrl: null,
          suggestedTags: null,
        });
        // The tab is this user's, so the page doesn't clear the drafts as someone else's.
        window.sessionStorage.setItem("gladrags:user", user);
        window.sessionStorage.setItem(
          key,
          JSON.stringify({
            userId: user,
            drafts: [
              { draft: draft(1), addedAt: Date.now() - 21 * 60 * 60 * 1000 },
              { draft: draft(2), addedAt: Date.now() },
            ],
          }),
        );
      },
      { key: BATCH_DRAFTS_KEY, user: MOCK_USER_ID },
    );
    await page.reload();
    await expect(page.getByRole("link", { name: /Review 1 new item(?!s)/ })).toBeVisible();
    await page.goto("/wardrobe/review");
    await expect(page.getByRole("heading", { name: "Need tags (1)" })).toBeVisible();
  });
});

test.describe("get-started checklist (QA)", () => {
  test("with storage blocked it still shows on an empty wardrobe", async ({ page }) => {
    await page.addInitScript(() => {
      for (const name of ["localStorage", "sessionStorage"]) {
        Object.defineProperty(window, name, {
          get() {
            throw new DOMException("blocked", "SecurityError");
          },
        });
      }
    });
    await page.route(
      (url) => url.pathname === "/api/items",
      (route) => route.fulfill({ json: { items: [] } }),
    );
    await page.route("**/api/outfits", (route) => route.fulfill({ json: { outfits: [] } }));
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/wardrobe");
    await expect(page.getByRole("heading", { name: "Your wardrobe is empty" })).toBeVisible();
    await expect(page.getByText("0 of 4 done")).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("with storage blocked, 'Hide' hides it for this visit", async ({ page }) => {
    // Known bug, reported: the button does nothing when storage is blocked.
    test.fail();
    await page.addInitScript(() => {
      Object.defineProperty(window, "localStorage", {
        get() {
          throw new DOMException("blocked", "SecurityError");
        },
      });
    });
    await page.route(
      (url) => url.pathname === "/api/items",
      (route) => route.fulfill({ json: { items: [] } }),
    );
    await page.route("**/api/outfits", (route) => route.fulfill({ json: { outfits: [] } }));
    await page.goto("/wardrobe");
    await page.getByRole("button", { name: "Hide the get-started checklist" }).click();
    await expect(page.getByRole("heading", { name: "Your wardrobe is empty" })).toHaveCount(0, { timeout: 3_000 });
  });

  test("a dismissal by another user on this device doesn't hide it", async ({ page }) => {
    await page.route(
      (url) => url.pathname === "/api/items",
      (route) => route.fulfill({ json: { items: [] } }),
    );
    await page.route("**/api/outfits", (route) => route.fulfill({ json: { outfits: [] } }));
    await page.goto("/wardrobe");
    await page.evaluate((other) => window.localStorage.setItem(`gladrags-checklist:${other}`, JSON.stringify({ dismissed: true })), OTHER_USER_ID);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Your wardrobe is empty" })).toBeVisible();
  });
});

test.describe("settings (QA)", () => {
  test("clipboard blocked: the address is selected to copy by hand", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText: () => Promise.reject(new DOMException("denied", "NotAllowedError")) },
        configurable: true,
      });
    });
    await page.goto("/settings");
    const address = (await page.getByTestId("forwarding-address").textContent())!.trim();
    await page.getByRole("button", { name: "Copy address" }).click();
    await expect(page.getByText("Selected: copy it from the menu.")).toBeVisible();
    expect(await page.evaluate(() => window.getSelection()?.toString().trim())).toBe(address);
  });

  test("a null address says email import isn't set up, with no copy or reset", async ({ page }) => {
    await page.route("**/api/settings", (route) =>
      route.fulfill({ json: { favouriteShopIds: ["next"], forwardingAddress: null } }),
    );
    await page.goto("/settings");
    await expect(page.getByText(/Email import isn.t set up yet/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Copy address" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Get a new address" })).toHaveCount(0);
    await checkPhoneLayout(page, "settings without an address");
  });

  test("unticking every shop can't be saved", async ({ page }) => {
    let puts = 0;
    await page.route("**/api/settings", async (route) => {
      if (route.request().method() === "PUT") puts++;
      await route.fulfill({ json: { favouriteShopIds: ["next"], forwardingAddress: null } });
    });
    await page.goto("/settings");
    await page.getByText("Next", { exact: true }).click();
    await expect(page.getByText("Pick at least one shop.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Save shops" })).toBeDisabled();
    expect(puts).toBe(0);
  });

  test("email import statuses and reasons", async ({ page }) => {
    const at = "2026-10-30T10:00:00Z";
    const row = (id: number, rest: object) => ({
      id: `0a000000-0000-4000-8000-0000000000${String(id).padStart(2, "0")}`,
      receivedAt: at,
      shopName: "Next",
      orderDate: null,
      itemCount: 0,
      skippedCount: 0,
      error: null,
      ...rest,
    });
    await page.route("**/api/email-imports", (route) =>
      route.fulfill({
        json: {
          imports: [
            row(1, { status: "processing" }),
            row(2, { status: "done", itemCount: 3 }),
            row(3, { status: "done", itemCount: 1, skippedCount: 2, error: "daily_cap_reached" }),
            row(4, { status: "failed", error: "sender_not_allowed", shopName: null }),
            row(5, { status: "failed", error: "ai_paused" }),
          ],
        },
      }),
    );
    await page.goto("/settings");
    await expect(page.getByText("Adding the items…")).toBeVisible();
    await expect(page.getByText("Added 3 items to review")).toBeVisible();
    await expect(page.getByText("Added 1 item to review; 2 items left out")).toBeVisible();
    await expect(page.getByText("It wasn't forwarded from your sign-in address.")).toBeVisible();
    await expect(page.getByText("Adding is paused until next month.")).toBeVisible();
    await checkPhoneLayout(page, "settings with email imports");
  });
});
