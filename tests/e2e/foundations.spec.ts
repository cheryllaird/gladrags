import { expect, test, type APIResponse } from "@playwright/test";

// Foundations-level checks on a 390 px phone viewport, against mock mode.
// The five core journeys need the wardrobe and outfit screens (milestone 3);
// until then these cover sign-in and the API contracts over real HTTP.
//
// The mock store is shared by every test on the server, so tests here only
// ever ADD data, never delete it. Each run uses 3 of the mock user's 40
// daily items, so restart a long-lived local server (reuseExistingServer)
// after a dozen runs or the upload tests will hit daily_cap_reached.

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);

interface ApiErrorBody {
  error: { code: string; message: string; issues?: { path: string; message: string }[] };
}

async function expectApiError(res: APIResponse, status: number, code: string) {
  expect(res.status()).toBe(status);
  const body = (await res.json()) as ApiErrorBody;
  expect(body.error.code).toBe(code);
  expect(typeof body.error.message).toBe("string");
  return body.error;
}

test.describe("sign-in (mock mode)", () => {
  test("email, then code, then lands on the requested page", async ({ page }) => {
    await page.goto("/sign-in?next=%2F");
    await expect(page.getByText("Mock mode")).toBeVisible();
    await page.getByLabel("Email").fill("cheryl@example.com");
    await page.getByRole("button", { name: "Email me a sign-in link" }).click();
    await expect(page.getByText("cheryl@example.com")).toBeVisible();
    await page.getByLabel("Code from the email").fill("123456");
    await page.getByRole("button", { name: "Sign in" }).click();
    // "/" is the wardrobe now (wardrobe-ui).
    await expect(page).toHaveURL(/\/wardrobe$/);
    await expect(page.getByRole("heading", { name: "Wardrobe" })).toBeVisible();
  });

  test("an off-site next is ignored: you end up on this site", async ({ page, baseURL }) => {
    await page.goto("/sign-in?next=%2F%2Fevil.example.com");
    await page.getByLabel("Email").fill("cheryl@example.com");
    await page.getByRole("button", { name: "Email me a sign-in link" }).click();
    await page.getByLabel("Code from the email").fill("123456");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL((url) => url.pathname === "/wardrobe");
    expect(new URL(page.url()).origin).toBe(new URL(baseURL!).origin);
  });

  test("an email that isn't on the allowlist gets the invite-only message", async ({ page }) => {
    await page.goto("/sign-in");
    await page.getByLabel("Email").fill("not-invited@example.com");
    await page.getByRole("button", { name: "Email me a sign-in link" }).click();
    // Next adds its own empty role="alert" route announcer, so match by text.
    await expect(page.getByRole("alert").filter({ hasText: "invite-only" })).toBeVisible();
    await expect(page.getByLabel("Code from the email")).toHaveCount(0);
  });

  test("'Use a different email' goes back to the email step", async ({ page }) => {
    await page.goto("/sign-in");
    await page.getByLabel("Email").fill("cheryl@example.com");
    await page.getByRole("button", { name: "Email me a sign-in link" }).click();
    await page.getByRole("button", { name: "Use a different email" }).click();
    await expect(page.getByLabel("Email")).toBeVisible();
  });

  test("a bad or expired link shows a message", async ({ page }) => {
    await page.goto("/sign-in?error=link");
    await expect(page.getByRole("alert").filter({ hasText: "didn't work or has expired" })).toBeVisible();
  });

  test("the sign-in page fits a 390 px screen with no sideways scroll", async ({ page }) => {
    await page.goto("/sign-in");
    expect(page.viewportSize()?.width).toBe(390);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

test.describe("API contracts over HTTP (mock mode)", () => {
  test("invalid input returns the documented error shape", async ({ request }) => {
    const filter = await expectApiError(await request.get("/api/items?category=bags"), 400, "bad_request");
    expect(filter.issues?.[0]?.path).toBe("category");
    await expectApiError(await request.post("/api/outfits", { data: { style: "work", count: 9 } }), 400, "bad_request");
    await expectApiError(await request.get("/api/items/not-a-uuid"), 404, "not_found");
    await expectApiError(
      await request.post("/api/items/photo", { multipart: { original: { name: "a.gif", mimeType: "image/gif", buffer: Buffer.from("GIF89a") } } }),
      400,
      "bad_request",
    );
  });

  test("add by photo without a cut-out, then save: the item appears in the wardrobe", async ({ request }) => {
    const upload = await request.post("/api/items/photo", {
      multipart: { original: { name: "photo.jpg", mimeType: "image/jpeg", buffer: JPEG } },
    });
    expect(upload.status()).toBe(200);
    const { draft } = await upload.json();
    expect(draft.cutoutImageKey).toBeNull();
    expect(draft.suggestedTags).not.toBeNull();

    const description = `QA e2e item ${Date.now()}`;
    const save = await request.post("/api/items", {
      data: {
        source: draft.source,
        sourceUrl: draft.sourceUrl,
        originalImageKey: draft.originalImageKey,
        cutoutImageKey: null,
        tags: { ...draft.suggestedTags, description },
        tagsEdited: true,
      },
    });
    expect(save.status()).toBe(201);
    const list = await (await request.get(`/api/items?q=${encodeURIComponent(description)}`)).json();
    expect(list.items).toHaveLength(1);
    expect(list.items[0].cutoutUrl).toBeNull();
  });

  test("add by link: a blocked shop asks for a screenshot, which keeps the link", async ({ request }) => {
    const url = "https://blocked.example.com/p/1";
    const step1 = await (await request.post("/api/items/link", { data: { url } })).json();
    expect(step1).toMatchObject({ status: "needs_screenshot", reason: "fetch_blocked", sourceUrl: url });
    const shot = await request.post("/api/items/photo", {
      multipart: { original: { name: "shot.png", mimeType: "image/png", buffer: PNG }, sourceUrl: url },
    });
    const { draft } = await shot.json();
    expect(draft).toMatchObject({ source: "link", sourceUrl: url });
  });

  test("add by link: an ok shop goes through step 2 with a cut-out", async ({ request }) => {
    const step1 = await (await request.post("/api/items/link", { data: { url: "https://shop.example.com/p/1" } })).json();
    expect(step1.status).toBe("ok");
    const meta = JSON.stringify({ sourceUrl: step1.sourceUrl, originalImageKey: step1.originalImageKey, product: step1.product });
    const step2 = await request.post("/api/items/link/cutout", {
      multipart: { meta, cutout: { name: "cutout.png", mimeType: "image/png", buffer: PNG } },
    });
    expect(step2.status()).toBe(200);
    const { draft } = await step2.json();
    expect(draft.cutoutImageKey).not.toBeNull();
  });

  test("outfits: 4 by default, each with a top and bottom or a dress, plus one pair of shoes", async ({ request }) => {
    const res = await request.post("/api/outfits", { data: { style: { kind: "preset", presetId: "smart_casual" } } });
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.outfits).toHaveLength(4);
    for (const outfit of body.outfits) {
      const cats: string[] = outfit.items.map((i: { tags: { category: string } }) => i.tags.category);
      expect(cats.filter((c) => c === "shoes")).toHaveLength(1);
      expect(cats.includes("dress_jumpsuit") || (cats.includes("top") && cats.includes("bottom"))).toBe(true);
    }
  });

  test("usage reports today's counts and the reset time", async ({ request }) => {
    const usage = await (await request.get("/api/usage")).json();
    expect(usage.itemsToday.limit).toBe(40);
    expect(usage.outfitRequestsToday.limit).toBe(25);
    expect(new Date(usage.dailyResetAt).getTime()).toBeGreaterThan(Date.now());
    expect(usage.aiPaused).toBe(false);
  });
});

test.describe("PWA files", () => {
  test("the service worker is never HTTP-cached and the offline page is public", async ({ request }) => {
    const sw = await request.get("/sw.js");
    expect(sw.ok()).toBe(true);
    expect(sw.headers()["cache-control"]).toContain("no-store");
    expect((await request.get("/offline.html")).ok()).toBe(true);
  });
});
