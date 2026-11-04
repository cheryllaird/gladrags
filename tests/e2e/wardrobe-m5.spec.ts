import { readFileSync } from "node:fs";
import { expect, test, type Page, type Request } from "@playwright/test";
import { checkPhoneLayout } from "./phone-layout";

// Milestone 5 wardrobe screens at 390 px, in mock mode (CONTRACTS.md
// section 1, markers): several photos and several links at once, the
// review list, the get-started checklist, settings, and items added by
// email without a picture.
//
// The mock store is shared by every test running in parallel, so tests
// that need an exact list answer GET /api/items themselves.

const PHOTO = readFileSync(new URL("./fixtures/shirt.jpg", import.meta.url));
const SUGGESTED = "Navy and white striped linen shirt";
const MOCK_EMAIL = "mock.user@gladrags.test";

const photo = (name: string) => ({ name, mimeType: "image/jpeg", buffer: PHOTO });

/** The multipart field names and text values of an upload (files show as their file name). */
function formFields(request: Request): Record<string, string> {
  const body = request.postDataBuffer()?.toString("latin1") ?? "";
  const fields: Record<string, string> = {};
  for (const part of body.split(/--[-\w]+\r\n/)) {
    const name = part.match(/name="([^"]+)"/)?.[1];
    if (!name) continue;
    const filename = part.match(/filename="([^"]*)"/)?.[1];
    fields[name] = filename ?? part.split("\r\n\r\n")[1]?.replace(/\r\n(--[-\w]+--)?\r?\n?$/, "") ?? "";
  }
  return fields;
}

function isItemsList(url: URL, needsReview: boolean): boolean {
  return url.pathname === "/api/items" && (url.searchParams.get("needsReview") === "true") === needsReview;
}

async function postEmail(page: Page, from: string): Promise<void> {
  const settings = await (await page.request.get("/api/settings")).json();
  const response = await page.request.post("/api/inbound/email", {
    data: {
      messageId: `<qa-${Date.now()}-${Math.random()}@mail.example>`,
      from,
      to: [settings.forwardingAddress],
      subject: "Fwd: Your order",
      text: "Order",
      html: null,
      receivedAt: new Date().toISOString(),
      auth: { spf: "pass", dkim: "pass", dmarc: "pass" },
      spam: { isSpam: false, score: 0 },
    },
  });
  expect(response.status()).toBe(200);
}

test.describe("several photos at once", () => {
  test("uploads one after another, saved to review, with per-photo progress and a summary", async ({ page }) => {
    const uploads: Record<string, string>[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    await page.route("**/api/items/photo", async (route) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      uploads.push(formFields(route.request()));
      const response = await route.fetch();
      inFlight--;
      await route.fulfill({ response });
    });

    await page.goto("/add");
    await page.getByTestId("photo-library-input").setInputFiles([photo("a.jpg"), photo("b.jpg"), photo("IMG_3.jpg")]);
    await expect(page.getByRole("heading", { name: "Adding photos" })).toBeVisible();
    await expect(page.getByText("All 3 photos added")).toBeVisible();
    await expect(page.getByText("3 items are in your wardrobe, marked to review.")).toBeVisible();

    const rows = page.getByRole("list", { name: "Photos" }).getByRole("listitem");
    await expect(rows).toHaveCount(3);
    for (const row of await rows.all()) await expect(row).toContainText(`Added: ${SUGGESTED}`);

    expect(maxInFlight).toBe(1);
    expect(uploads.map((f) => f.original)).toEqual(["a.jpg", "b.jpg", "IMG_3.jpg"]);
    for (const fields of uploads) {
      expect(fields.saveForReview).toBe("true");
      // No background removal while adding.
      expect(fields.cutout).toBeUndefined();
    }
    await checkPhoneLayout(page, "batch summary");

    await page.getByRole("link", { name: "Review new items" }).click();
    await expect(page).toHaveURL(/\/wardrobe\/review$/);
    await expect(page.getByRole("heading", { name: /To review \(\d+\)/ })).toBeVisible();
  });

  test("stops cleanly at the daily item cap and says how many were added", async ({ page }) => {
    const sent: string[] = [];
    await page.route("**/api/items/photo", async (route) => {
      sent.push(formFields(route.request()).original ?? "");
      await route.continue();
    });
    await page.goto("/add");
    await page
      .getByTestId("photo-library-input")
      .setInputFiles([photo("one.jpg"), photo("two.jpg"), photo("three-mock-daily-cap.jpg"), photo("four.jpg")]);
    await expect(page.getByText("That's today's limit")).toBeVisible();
    await expect(page.getByText("2 were added before it stopped; the other 2 photos weren't.")).toBeVisible();
    await expect(page.getByText(/You've added 40 items today\. You can add more/)).toBeVisible();
    const rows = page.getByRole("list", { name: "Photos" }).getByRole("listitem");
    await expect(rows.nth(2)).toContainText("Not added");
    await expect(rows.nth(3)).toContainText("Not added");
    // Nothing more was sent after the cap.
    expect(sent).toEqual(["one.jpg", "two.jpg", "three-mock-daily-cap.jpg"]);
  });

  test("a photo whose tagging fails becomes a draft to fill in from the review list", async ({ page }) => {
    await page.goto("/add");
    await page.getByTestId("photo-library-input").setInputFiles([photo("fine.jpg"), photo("shirt-mock-no-tags.jpg")]);
    await expect(page.getByText("Done", { exact: true })).toBeVisible();
    await expect(page.getByText("1 couldn't be tagged automatically: fill in the tags in the review list.")).toBeVisible();
    await expect(page.getByRole("list", { name: "Photos" }).getByRole("listitem").nth(1)).toContainText("Couldn't be tagged");

    await page.getByRole("link", { name: "Review new items" }).click();
    await expect(page.getByRole("heading", { name: "Need tags (1)" })).toBeVisible();
    await page.getByRole("button", { name: "Fill in tags" }).click();
    await expect(page.getByRole("heading", { name: "Fill in the tags" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Save to wardrobe" })).toBeVisible();
  });

  test("a photo that can't be read fails on its own; the rest carry on", async ({ page }) => {
    await page.goto("/add");
    await page
      .getByTestId("photo-library-input")
      .setInputFiles([{ name: "IMG_9.HEIC", mimeType: "image/heic", buffer: Buffer.from("not really a heic") }, photo("ok.jpg")]);
    await expect(page.getByText("1 couldn't be added (see below).")).toBeVisible();
    const rows = page.getByRole("list", { name: "Photos" }).getByRole("listitem");
    await expect(rows.nth(0)).toHaveAttribute("data-state", "failed");
    await expect(rows.nth(1)).toContainText(`Added: ${SUGGESTED}`);
  });

  test("one photo from the library still opens the tag review, as before", async ({ page }) => {
    await page.goto("/add");
    await page.getByTestId("photo-library-input").setInputFiles(photo("single.jpg"));
    await expect(page.getByRole("heading", { name: "Check the tags" })).toBeVisible();
  });
});

test.describe("several links at once", () => {
  test("finds and de-duplicates the links, imports them in turn, and lists the ones needing a screenshot", async ({ page }) => {
    const step2: string[] = [];
    await page.route("**/api/items/link/cutout", async (route) => {
      step2.push(formFields(route.request()).meta ?? "");
      await route.continue();
    });
    const stamp = Date.now();
    const a = `https://shop.example.com/p/a-${stamp}`;
    const b = `https://shop.example.com/p/b-${stamp}`;
    const blocked = `https://blocked.example.com/p/${stamp}`;
    await page.goto("/add/link");
    await page.getByLabel("Product links").fill(`Bought these:\n${a}\n${b}, and ${a} again\n(${blocked}).`);
    await expect(page.getByText("3 different links found.")).toBeVisible();
    await page.getByRole("button", { name: "Add 3 links" }).click();

    await expect(page.getByText("Done", { exact: true })).toBeVisible();
    await expect(page.getByText("2 items are in your wardrobe, marked to review.")).toBeVisible();
    await expect(page.getByText("1 link needs a screenshot: the site couldn't be read. Add them below.")).toBeVisible();
    for (const meta of step2) expect(JSON.parse(meta)).toMatchObject({ saveForReview: true });
    expect(step2).toHaveLength(2);
    await checkPhoneLayout(page, "link batch summary");

    // The screenshot for the blocked one goes through the photo route with its link, saved to review.
    const rows = page.getByRole("list", { name: "Links" }).getByRole("listitem");
    const blockedRow = rows.filter({ hasText: "blocked.example.com" });
    const upload = page.waitForRequest((r) => new URL(r.url()).pathname === "/api/items/photo");
    await blockedRow.getByTestId("screenshot-input").setInputFiles(photo("screenshot.jpg"));
    const fields = formFields(await upload);
    expect(fields).toMatchObject({ sourceUrl: blocked, saveForReview: "true" });
    await expect(blockedRow).toContainText(`Added: ${SUGGESTED}`);
    await expect(page.getByText("All 3 links added")).toBeVisible();
  });

  test("one pasted link still goes to the single review", async ({ page }) => {
    await page.goto("/add/link");
    await page.getByLabel("Product links").fill(`see https://shop.example.com/p/single-${Date.now()} thanks`);
    await page.getByRole("button", { name: "Add from link" }).click();
    await expect(page.getByRole("heading", { name: "Check the tags" })).toBeVisible();
  });

  test("the daily cap stops a link batch", async ({ page }) => {
    await page.goto("/add/link");
    await page.getByLabel("Product links").fill(`https://shop.example.com/p/x-${Date.now()}\nhttps://shop.example.com/p/y?m=mock-daily-cap\nhttps://shop.example.com/p/z`);
    await page.getByRole("button", { name: "Add 3 links" }).click();
    await expect(page.getByText("That's today's limit")).toBeVisible();
    await expect(page.getByText("1 was added before it stopped; the other 2 links weren't.")).toBeVisible();
  });
});

test.describe("review list", () => {
  test("the wardrobe banner opens the list; confirm one, edit one, then confirm all", async ({ page }) => {
    const all = (await (await page.request.get("/api/items")).json()).items as { id: string; tags: { description: string } }[];
    const waiting = all.slice(0, 4).map((item) => ({ ...item, needsReview: true }));
    let list = waiting;
    const patches: unknown[] = [];
    let confirmedAll: unknown = null;
    await page.route(
      (url) => isItemsList(url, true),
      (route) => route.fulfill({ json: { items: list } }),
    );
    // The banner counts the unfiltered list's own "to review" items.
    await page.route(
      (url) => isItemsList(url, false),
      (route) => route.fulfill({ json: { items: all.map((item) => ({ ...item, needsReview: waiting.some((w) => w.id === item.id) })) } }),
    );
    await page.route("**/api/items/*", async (route) => {
      if (route.request().method() !== "PATCH") return route.continue();
      patches.push(route.request().postDataJSON());
      const id = new URL(route.request().url()).pathname.split("/").pop();
      const item = waiting.find((i) => i.id === id)!;
      return route.fulfill({ json: { item: { ...item, needsReview: false } } });
    });
    await page.route("**/api/items/reviewed", async (route) => {
      confirmedAll = route.request().postDataJSON();
      return route.fulfill({ json: { updated: 2 } });
    });

    await page.goto("/wardrobe");
    await page.getByRole("link", { name: /Review 4 new items/ }).click();
    await expect(page.getByRole("heading", { name: "To review (4)" })).toBeVisible();
    await checkPhoneLayout(page, "review list");

    const first = page.getByRole("listitem", { name: waiting[0]!.tags.description });
    await first.getByRole("button", { name: "Looks right" }).click();
    await expect(page.getByRole("heading", { name: "To review (3)" })).toBeVisible();
    expect(patches[0]).toEqual({ reviewed: true });

    await page.getByRole("listitem", { name: waiting[1]!.tags.description }).getByRole("button", { name: "Edit tags" }).click();
    await page.getByLabel("Description").fill("Corrected in review");
    await page.getByRole("button", { name: "Save tags" }).click();
    await expect(page.getByText("Saved: Corrected in review")).toBeVisible();
    expect(patches[1]).toMatchObject({ tags: { description: "Corrected in review" } });

    list = waiting.slice(2);
    await page.getByRole("button", { name: "Confirm all 2" }).click();
    await expect(page.getByText("All caught up")).toBeVisible();
    expect(confirmedAll).toEqual({ itemIds: waiting.slice(2).map((i) => i.id) });
  });

  test("an email item without a picture can have a photo added", async ({ page }) => {
    await postEmail(page, MOCK_EMAIL);
    const toReview = (await (await page.request.get("/api/items?needsReview=true")).json()).items as {
      id: string;
      needsPhoto: boolean;
      tags: { description: string };
    }[];
    const noPicture = toReview.find((item) => item.needsPhoto)!;
    expect(noPicture).toBeDefined();
    await page.route(
      (url) => isItemsList(url, true),
      (route) => route.fulfill({ json: { items: [noPicture] } }),
    );

    await page.goto("/wardrobe/review");
    const card = page.getByRole("listitem", { name: noPicture.tags.description });
    await expect(card.getByText("No picture came with this one.")).toBeVisible();
    await expect(card.getByText("From an order email")).toBeVisible();
    const put = page.waitForRequest((r) => r.method() === "PUT" && new URL(r.url()).pathname === `/api/items/${noPicture.id}/photo`);
    await card.getByTestId("add-photo-input").setInputFiles(photo("IMG_77.jpg"));
    expect(formFields(await put).original).toBe("IMG_77.jpg");
    await expect(page.getByText("Photo added. Check the tags still match it.")).toBeVisible();
    await expect(card.getByText("No picture came with this one.")).toHaveCount(0);
  });

  test("item detail confirms tags for an item still to review", async ({ page }) => {
    await page.goto("/add");
    await page.getByTestId("photo-library-input").setInputFiles([photo("d1.jpg"), photo("d2.jpg")]);
    await expect(page.getByText("All 2 photos added")).toBeVisible();
    const toReview = (await (await page.request.get("/api/items?needsReview=true")).json()).items as { id: string; needsPhoto: boolean }[];
    const item = toReview.find((i) => !i.needsPhoto)!;
    await page.goto(`/wardrobe/${item.id}`);
    await page.getByRole("button", { name: "Tags look right" }).click();
    await expect(page.getByText("Tags confirmed.")).toBeVisible();
    expect((await (await page.request.get(`/api/items/${item.id}`)).json()).item.needsReview).toBe(false);
  });
});

test.describe("get-started checklist", () => {
  test("replaces the empty grid, shows progress, links each step, and can be dismissed", async ({ page }) => {
    await page.route(
      (url) => isItemsList(url, false),
      (route) => route.fulfill({ json: { items: [] } }),
    );
    await page.route("**/api/outfits", (route) => route.fulfill({ json: { outfits: [] } }));
    await page.goto("/wardrobe");
    await expect(page.getByRole("heading", { name: "Your wardrobe is empty" })).toBeVisible();
    await expect(page.getByText("0 of 4 done")).toBeVisible();
    await expect(page.getByText(/Outfits work from your first item/).first()).toBeVisible();
    await expect(page.getByRole("link", { name: /Add your first item/ })).toHaveAttribute("href", "/add");
    await expect(page.getByRole("link", { name: /Add several at once/ })).toHaveAttribute("href", "/add");
    await expect(page.getByRole("link", { name: /Forward an order email/ })).toHaveAttribute("href", "/settings#order-emails");
    await expect(page.getByRole("link", { name: /Get your first outfit/ })).toHaveAttribute("href", "/outfits");
    await checkPhoneLayout(page, "get-started checklist");

    await page.getByRole("button", { name: "Hide the get-started checklist" }).click();
    await expect(page.getByRole("heading", { name: "Your wardrobe is empty" })).toHaveCount(0);
    await page.reload();
    await expect(page.getByText("Photograph an item or paste a product link to get started.")).toBeVisible();
    await expect(page.getByText("0 of 4 done")).toHaveCount(0);
  });

  test("on a nearly empty wardrobe it sits above the grid and ticks what's done", async ({ page }) => {
    const items = (await (await page.request.get("/api/items")).json()).items.slice(0, 2);
    await page.route(
      (url) => isItemsList(url, false),
      (route) => route.fulfill({ json: { items } }),
    );
    await page.route("**/api/outfits", (route) => route.fulfill({ json: { outfits: [] } }));
    await page.goto("/wardrobe");
    await expect(page.getByRole("heading", { name: "Get started" })).toBeVisible();
    await expect(page.getByText("1 of 4 done")).toBeVisible();
    await expect(page.getByText("2 items")).toBeVisible();
  });

  test("isn't shown on a stocked wardrobe", async ({ page }) => {
    await page.goto("/wardrobe");
    await expect(page.getByRole("link", { name: "Camel wool overcoat" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Get started" })).toHaveCount(0);
  });
});

test.describe("settings", () => {
  test("from the account sheet: forwarding address, copy, reset after confirming, recent emails, shops", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    // A refused email shows with its reason.
    await postEmail(page, "someone.else@example.com");

    await page.goto("/wardrobe");
    await page.getByRole("button", { name: "Account" }).click();
    await page.getByRole("link", { name: /Settings/ }).click();
    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();

    const address = page.getByTestId("forwarding-address");
    const before = (await address.textContent())!.trim();
    expect(before).toMatch(/^[0-9a-f]{32}@/);
    await expect(page.getByText(`Forward it to the address above, from ${MOCK_EMAIL}.`)).toBeVisible();
    await page.getByRole("button", { name: "Copy address" }).click();
    await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(before);

    await expect(page.getByText("It wasn't forwarded from your sign-in address.").first()).toBeVisible();
    await checkPhoneLayout(page, "settings");

    // Reset asks first; keeping changes nothing. (The reset is answered here,
    // so the shared mock address other tests post emails to stays put.)
    let resets = 0;
    await page.route("**/api/settings/forwarding-address", async (route) => {
      resets++;
      const settings = await (await page.request.get("/api/settings")).json();
      await route.fulfill({ json: { ...settings, forwardingAddress: `fedcba9876543210fedcba9876543210@${before.split("@")[1]}` } });
    });
    await page.getByRole("button", { name: "Get a new address" }).click();
    const dialog = page.getByRole("alertdialog", { name: "Get a new forwarding address?" });
    await dialog.getByRole("button", { name: "Keep this address" }).click();
    await expect(address).toHaveText(before);
    expect(resets).toBe(0);
    await page.getByRole("button", { name: "Get a new address" }).click();
    await dialog.getByRole("button", { name: "Get a new address" }).click();
    await expect(page.getByText("You have a new address. The old one no longer works.")).toBeVisible();
    await expect(address).not.toHaveText(before);
    expect(resets).toBe(1);

    // Favourite shops: add one, save, then put them back for other tests.
    const saved = (await (await page.request.get("/api/settings")).json()).favouriteShopIds as string[];
    await expect(page.getByRole("checkbox", { name: "Next" })).toBeChecked();
    await page.getByText("Zara", { exact: true }).click();
    const put = page.waitForRequest((r) => r.method() === "PUT" && new URL(r.url()).pathname === "/api/settings");
    await page.getByRole("button", { name: "Save shops" }).click();
    expect((await put).postDataJSON().favouriteShopIds).toContain("zara");
    await expect(page.getByText("Shops saved.")).toBeVisible();
    await page.request.put("/api/settings", { data: { favouriteShopIds: saved } });
  });

  test("the checklist's email step opens settings at the forwarding address", async ({ page }) => {
    await page.goto("/settings#order-emails");
    await expect(page.getByRole("heading", { name: "Add items from order emails" })).toBeInViewport();
  });
});
