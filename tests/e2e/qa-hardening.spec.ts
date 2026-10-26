import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { fakeBackgroundRemoverForFile } from "./helpers";

fakeBackgroundRemoverForFile();

// QA for fix/ui-hardening, at 390 px against mock mode:
// - a shared link (/add/link?url=… or ?text=…) never reaches /api/items/link
//   without a tap, whatever the page is opened with or however it's revisited;
// - a draft or lost-photo note kept when a session expires is only handed
//   back to the user who kept it, per tab, and the tab is cleared once an
//   account is really deleted;
// - the /privacy note works as a stand-alone page.
//
// Mock mode always signs in as the same user, so "someone else signs in"
// is played by rewriting the kept entry while the tab sits on /sign-in.

const PHOTO = readFileSync(new URL("./fixtures/shirt.jpg", import.meta.url));
const MOCK_USER = "0a000000-0000-4000-8000-000000000001";
const OTHER_USER = "0a000000-0000-4000-8000-0000000000ee";
const PENDING = "gladrags:pending-add";

const TAGS = {
  category: "top",
  subcategory: "shirt",
  colours: ["navy"],
  pattern: "plain",
  formality: 2,
  seasons: ["spring"],
  warmth: "light",
  occasions: ["casual"],
  fabric: "linen",
  description: "Navy linen shirt",
};

function draftBody(sourceUrl: string) {
  return {
    draft: {
      source: "link",
      sourceUrl,
      originalImageKey: `${MOCK_USER}/1b000000-0000-4000-8000-0000000000e1.jpg`,
      cutoutImageKey: `${MOCK_USER}/1b000000-0000-4000-8000-0000000000e2.png`,
      originalUrl: "/mock/items/blue-oxford-shirt.svg",
      cutoutUrl: "/mock/items/blue-oxford-shirt.svg",
      suggestedTags: TAGS,
    },
  };
}

function apiError(code: string, message: string) {
  return { error: { code, message } };
}

async function signInAgain(page: Page) {
  await expect(
    page.getByRole("heading", { name: "Sign in to GladRags" }),
  ).toBeVisible();
  await page.getByLabel("Email").fill("cheryl@example.com");
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await page.getByLabel("Code from the email").fill("123456");
  await page.getByRole("button", { name: "Sign in" }).click();
}

async function choosePhoto(page: Page, name: string) {
  await page
    .getByTestId("photo-library-input")
    .setInputFiles({ name, mimeType: "image/jpeg", buffer: PHOTO });
}

/** Rewrite the kept entry as if `userId` had kept it (and, for a draft, its images are in their folder). */
async function handKeptEntryTo(page: Page, userId: string) {
  const before = await page.evaluate(
    ({ key, userId }) => {
      const raw = sessionStorage.getItem(key);
      if (!raw) return null;
      const value = JSON.parse(raw);
      const owner = value.userId as string;
      value.userId = userId;
      if (value.draft) {
        value.draft.originalImageKey = value.draft.originalImageKey.replace(
          `${owner}/`,
          `${userId}/`,
        );
        if (value.draft.cutoutImageKey)
          value.draft.cutoutImageKey = value.draft.cutoutImageKey.replace(
            `${owner}/`,
            `${userId}/`,
          );
      }
      sessionStorage.setItem(key, JSON.stringify(value));
      return { owner, kind: value.kind as string };
    },
    { key: PENDING, userId },
  );
  expect(before?.owner).toBe(MOCK_USER);
  return before!;
}

const pendingEntry = (page: Page) =>
  page.evaluate((key) => sessionStorage.getItem(key), PENDING);

// ---------------------------------------------------------------------------
// Shared links
// ---------------------------------------------------------------------------

test.describe("shared links wait for a tap", () => {
  /** Count every request to /api/items/link (both steps), answering them so the daily cap isn't used. */
  async function watchLinkImports(page: Page) {
    const requests: string[] = [];
    page.on("request", (r) => {
      if (new URL(r.url()).pathname.startsWith("/api/items/link"))
        requests.push(`${r.method()} ${new URL(r.url()).pathname}`);
    });
    const dialogs: string[] = [];
    page.on("dialog", async (d) => {
      dialogs.push(d.message());
      await d.dismiss();
    });
    return { requests, dialogs };
  }

  test("a direct visit, a reload, and back/forward never import", async ({
    page,
  }) => {
    const link = "https://shop.example.com/p/back-forward";
    const { requests } = await watchLinkImports(page);
    await page.goto(`/add/link?url=${encodeURIComponent(link)}`);
    await expect(page.getByLabel("Product link")).toHaveValue(link);
    await page.waitForTimeout(800);
    await page.reload();
    await expect(page.getByLabel("Product link")).toHaveValue(link);

    await page.goto("/wardrobe");
    await expect(
      page.getByRole("link", { name: "Camel wool overcoat" }),
    ).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/\/add\/link\?url=/);
    await expect(
      page.getByRole("button", { name: "Import this link" }),
    ).toBeVisible();
    await page.goForward();
    await expect(page).toHaveURL(/\/wardrobe$/);
    await page.goBack();
    await expect(
      page.getByRole("button", { name: "Import this link" }),
    ).toBeVisible();
    await page.waitForTimeout(800);
    expect(requests).toEqual([]);
  });

  test("navigating to a shared link from inside the app (client-side) doesn't import", async ({
    page,
  }) => {
    const { requests } = await watchLinkImports(page);
    await page.goto("/wardrobe");
    await page.evaluate(() => {
      const a = document.createElement("a");
      a.href =
        "/add/link?url=" +
        encodeURIComponent("https://shop.example.com/p/in-app");
      a.textContent = "go";
      document.body.append(a);
      a.click();
    });
    await expect(
      page.getByRole("button", { name: "Import this link" }),
    ).toBeVisible();
    await page.waitForTimeout(800);
    expect(requests).toEqual([]);
  });

  test("the share-target form via `text` (with title) fills in and waits", async ({
    page,
  }) => {
    const { requests } = await watchLinkImports(page);
    const link = "https://shop.example.com/p/text-share?ref=app";
    await page.goto(
      `/add/link?title=${encodeURIComponent("A shirt")}&text=${encodeURIComponent(`Check this out: ${link}`)}`,
    );
    await expect(page.getByLabel("Product link")).toHaveValue(link);
    await expect(
      page.getByText("Shared to GladRags.", { exact: false }),
    ).toBeVisible();
    await page.waitForTimeout(800);
    expect(requests).toEqual([]);
  });

  test("repeated url and text params use only the first and still wait", async ({
    page,
  }) => {
    const { requests } = await watchLinkImports(page);
    await page.goto(
      `/add/link?url=${encodeURIComponent("https://a.example.com/p/1")}&url=${encodeURIComponent("https://b.example.com/p/2")}`,
    );
    await expect(page.getByLabel("Product link")).toHaveValue(
      "https://a.example.com/p/1",
    );
    await page.waitForTimeout(500);
    expect(requests).toEqual([]);
  });

  const notWeb: [string, string][] = [
    [
      "javascript: in url",
      "url=" + encodeURIComponent("javascript:alert(document.domain)"),
    ],
    [
      "javascript: in text",
      "text=" + encodeURIComponent("javascript:alert(1)"),
    ],
    [
      "data: in url",
      "url=" + encodeURIComponent("data:text/html,<script>alert(1)</script>"),
    ],
    ["vbscript: in url", "url=" + encodeURIComponent("vbscript:msgbox(1)")],
    ["file: in url", "url=" + encodeURIComponent("file:///etc/passwd")],
    ["ftp: in text", "text=" + encodeURIComponent("ftp://shop.example.com/p")],
    [
      "a protocol-relative link",
      "url=" + encodeURIComponent("//evil.example.com/p"),
    ],
    [
      "markup in text",
      "text=" + encodeURIComponent('<img src=x onerror="alert(1)">'),
    ],
  ];
  for (const [label, query] of notWeb) {
    test(`${label}: nothing filled in, nothing sent, nothing run`, async ({
      page,
    }) => {
      const { requests, dialogs } = await watchLinkImports(page);
      await page.goto(`/add/link?${query}`);
      await expect(page.getByLabel("Product link")).toHaveValue("");
      await expect(
        page.getByRole("button", { name: "Add from link" }),
      ).toBeDisabled();
      await expect(
        page.getByText("Shared to GladRags.", { exact: false }),
      ).toHaveCount(0);
      await page.waitForTimeout(500);
      expect(requests).toEqual([]);
      expect(dialogs).toEqual([]);
    });
  }

  const wrapped: [string, string, string][] = [
    [
      "javascript:",
      "javascript:alert(1)//https://shop.example.com/p/inside",
      "https://shop.example.com/p/inside",
    ],
    [
      "blob:",
      "blob:https://shop.example.com/123",
      "https://shop.example.com/123",
    ],
  ];
  for (const [label, shared, offered] of wrapped) {
    test(`a ${label} url with an https link inside only offers the https part, and waits`, async ({
      page,
    }) => {
      const { requests, dialogs } = await watchLinkImports(page);
      await page.goto(`/add/link?url=${encodeURIComponent(shared)}`);
      await expect(page.getByLabel("Product link")).toHaveValue(offered);
      await page.waitForTimeout(500);
      expect(requests).toEqual([]);
      expect(dialogs).toEqual([]);
    });
  }

  test("a very long shared url is offered, doesn't push the page sideways, and is refused on tap without a request", async ({
    page,
  }) => {
    const { requests } = await watchLinkImports(page);
    const link = `https://shop.example.com/p/${"a".repeat(6000)}`;
    await page.goto(`/add/link?url=${encodeURIComponent(link)}`);
    await expect(page.getByLabel("Product link")).toHaveValue(link);
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await page.getByRole("button", { name: "Import this link" }).click();
    await expect(
      page.getByText("Paste a full link starting with https://"),
    ).toBeVisible();
    await page.waitForTimeout(500);
    expect(requests).toEqual([]);
  });

  test("a link at the 2048-character limit imports on tap, once", async ({
    page,
  }) => {
    const base = "https://shop.example.com/p/";
    const link = base + "b".repeat(2048 - base.length);
    const posted: string[] = [];
    await page.route("**/api/items/link", async (route) => {
      posted.push(route.request().postDataJSON().url);
      await route.fulfill({
        status: 200,
        json: {
          status: "needs_screenshot",
          reason: "fetch_blocked",
          sourceUrl: link,
          message: "We couldn't read that page.",
        },
      });
    });
    await page.goto(`/add/link?url=${encodeURIComponent(link)}`);
    await page.waitForTimeout(500);
    expect(posted).toEqual([]);
    await page.getByRole("button", { name: "Import this link" }).click();
    await expect(
      page.getByRole("heading", { name: "Add a screenshot" }),
    ).toBeVisible();
    expect(posted).toEqual([link]);
  });
});

// ---------------------------------------------------------------------------
// Kept drafts and lost-photo notes
// ---------------------------------------------------------------------------

test.describe("kept add-item work is only for whoever kept it", () => {
  /** Review a link import, then have the save refused as signed out once. */
  async function keepLinkDraft(page: Page, link: string) {
    await page.route("**/api/items/link/cutout", (route) =>
      route.fulfill({ status: 200, json: draftBody(link) }),
    );
    let refused = false;
    await page.route(
      (url) => url.pathname === "/api/items",
      (route) => {
        if (route.request().method() !== "POST" || refused)
          return route.continue();
        refused = true;
        return route.fulfill({
          status: 401,
          json: apiError("unauthorized", "Sign in to continue."),
        });
      },
    );
    await page.goto("/add/link");
    await page.getByLabel("Product link").fill(link);
    await page.getByRole("button", { name: "Add from link" }).click();
    await expect(
      page.getByRole("heading", { name: "Check the tags" }),
    ).toBeVisible();
    await page.getByLabel("Description").fill("First user's linked jacket");
    await page.getByRole("button", { name: "Save to wardrobe" }).click();
    await expect(
      page.getByRole("heading", { name: "Sign in to GladRags" }),
    ).toBeVisible();
  }

  test("from /add/link: the owner gets the draft back after signing in (control)", async ({
    page,
  }) => {
    await keepLinkDraft(page, "https://shop.example.com/p/kept-link");
    await signInAgain(page);
    await expect(page).toHaveURL(/\/add\/link/);
    await expect(
      page.getByText("We kept the item you were adding."),
    ).toBeVisible();
    await expect(page.getByLabel("Description")).toHaveValue(
      "First user's linked jacket",
    );
  });

  test("from /add/link: someone else signing in on the tab sees none of it, and it's deleted", async ({
    page,
  }) => {
    await keepLinkDraft(page, "https://shop.example.com/p/kept-link-other");
    await handKeptEntryTo(page, OTHER_USER);
    await signInAgain(page);
    await expect(page).toHaveURL(/\/add\/link/);
    await expect(page.getByLabel("Product link")).toBeVisible();
    await expect(
      page.getByText("We kept the item you were adding."),
    ).toHaveCount(0);
    await expect(page.getByLabel("Description")).toHaveCount(0);
    await expect(page.getByText("First user's linked jacket")).toHaveCount(0);
    await expect.poll(() => pendingEntry(page)).toBeNull();
  });

  test("the lost-photo note isn't shown to the next person who signs in", async ({
    page,
  }) => {
    await page.route("**/api/items/photo", (route) =>
      route.fulfill({
        status: 401,
        json: apiError("unauthorized", "Sign in to continue."),
      }),
    );
    await page.goto("/add");
    await choosePhoto(page, "lost.jpg");
    await expect(
      page.getByRole("heading", { name: "Sign in to GladRags" }),
    ).toBeVisible();
    expect((await handKeptEntryTo(page, OTHER_USER)).kind).toBe("photo_lost");
    await page.unroute("**/api/items/photo");
    await signInAgain(page);
    await expect(page).toHaveURL(/\/add$/);
    await expect(
      page.getByRole("button", { name: "Choose from library" }),
    ).toBeVisible();
    await expect(page.getByText("Choose it again to carry on.")).toHaveCount(0);
    await expect.poll(() => pendingEntry(page)).toBeNull();
  });

  test("a tampered entry planted on the tab (invalid JSON, wrong types, climbing keys) shows nothing and is deleted", async ({
    page,
  }) => {
    const entries = [
      "{not json",
      JSON.stringify({
        kind: "draft",
        userId: MOCK_USER,
        draft: "x",
        cutoutFailed: "no",
        tags: 1,
      }),
      JSON.stringify({
        kind: "draft",
        userId: MOCK_USER,
        cutoutFailed: false,
        tags: null,
        draft: {
          ...draftBody("https://shop.example.com/p/x").draft,
          originalImageKey: `${MOCK_USER}/../${OTHER_USER}/1b000000-0000-4000-8000-0000000000e1.jpg`,
        },
      }),
      JSON.stringify({
        kind: "draft",
        userId: MOCK_USER,
        cutoutFailed: false,
        tags: null,
        draft: {
          ...draftBody("https://shop.example.com/p/x").draft,
          originalImageKey: `${MOCK_USER}x/1b000000-0000-4000-8000-0000000000e1.jpg`,
        },
      }),
    ];
    await page.goto("/wardrobe");
    for (const raw of entries) {
      await page.evaluate(({ key, raw }) => sessionStorage.setItem(key, raw), {
        key: PENDING,
        raw,
      });
      await page.goto("/add");
      await expect(
        page.getByRole("button", { name: "Choose from library" }),
      ).toBeVisible();
      await expect(
        page.getByText("We kept the item you were adding."),
      ).toHaveCount(0);
      await expect(
        page.getByRole("heading", { name: "Check the tags" }),
      ).toHaveCount(0);
      await expect.poll(() => pendingEntry(page)).toBeNull();
    }
  });

  test("two tabs: a draft kept in one tab doesn't appear in another, and still restores in its own", async ({
    page,
    context,
  }) => {
    let refused = false;
    await context.route(
      (url) => url.pathname === "/api/items",
      (route) => {
        if (route.request().method() !== "POST" || refused)
          return route.continue();
        refused = true;
        return route.fulfill({
          status: 401,
          json: apiError("unauthorized", "Sign in to continue."),
        });
      },
    );
    await page.goto("/add");
    await choosePhoto(page, "tab-one.jpg");
    await expect(
      page.getByRole("heading", { name: "Check the tags" }),
    ).toBeVisible();
    await page.getByLabel("Description").fill("Tab one's shirt");
    await page.getByRole("button", { name: "Save to wardrobe" }).click();
    await expect(
      page.getByRole("heading", { name: "Sign in to GladRags" }),
    ).toBeVisible();

    const second = await context.newPage();
    await second.goto("/add");
    await expect(
      second.getByRole("button", { name: "Choose from library" }),
    ).toBeVisible();
    await expect(
      second.getByText("We kept the item you were adding."),
    ).toHaveCount(0);
    await expect.poll(() => pendingEntry(second)).toBeNull();
    await second.close();

    await signInAgain(page);
    await expect(
      page.getByText("We kept the item you were adding."),
    ).toBeVisible();
    await expect(page.getByLabel("Description")).toHaveValue("Tab one's shirt");
  });
});

test.describe("deleting the account", () => {
  test("a failed delete keeps the tab's data; the retry that succeeds clears it", async ({
    page,
  }) => {
    let calls = 0;
    await page.route("**/api/account", (route) => {
      calls++;
      if (calls === 1)
        return route.fulfill({
          status: 500,
          json: apiError("internal", "Something went wrong on our side"),
        });
      return route.fulfill({ status: 200, json: { deleted: true } });
    });
    await page.goto("/wardrobe");
    await page.evaluate((user) => {
      sessionStorage.setItem(
        "gladrags:pending-add",
        JSON.stringify({ kind: "photo_lost", userId: user }),
      );
      sessionStorage.setItem("gladrags:wardrobe-search", "?q=secret");
      sessionStorage.setItem("other-app", "stays");
    }, MOCK_USER);
    const keys = () => page.evaluate(() => Object.keys(sessionStorage).sort());

    await page.getByRole("button", { name: "Account" }).click();
    await page
      .getByRole("dialog", { name: "Account" })
      .getByRole("button", { name: "Delete my account" })
      .click();
    const dialog = page.getByRole("alertdialog");
    await dialog.getByRole("button", { name: "Delete everything" }).click();
    await expect(
      dialog.getByText("Something went wrong on our side"),
    ).toBeVisible();
    // gladrags:user records whose the tab's data is (SignedInUser).
    expect(await keys()).toEqual([
      "gladrags:pending-add",
      "gladrags:user",
      "gladrags:wardrobe-search",
      "other-app",
    ]);

    await dialog.getByRole("button", { name: "Delete everything" }).click();
    await expect(page).toHaveURL(/\/sign-in$/);
    expect(await keys()).toEqual(["other-app"]);
    expect(calls).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// /privacy
// ---------------------------------------------------------------------------

test.describe("privacy note", () => {
  test("has no app chrome (no nav, no Account button) and its Back is a 44 px target", async ({
    page,
  }) => {
    await page.goto("/privacy");
    await expect(
      page.getByRole("heading", { level: 1, name: "Privacy" }),
    ).toBeVisible();
    await expect(page.getByRole("navigation")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Account" })).toHaveCount(0);
    const back = page.getByRole("link", { name: "Back to GladRags" });
    const box = (await back.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  });

  test("the sign-in link to it is a 44 px target, and browser Back returns to sign-in", async ({
    page,
  }) => {
    await page.goto("/sign-in");
    const link = page.getByRole("link", {
      name: "How your photos are handled",
    });
    const box = (await link.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
    await link.click();
    await expect(page).toHaveURL(/\/privacy$/);
    await page.goBack();
    await expect(
      page.getByRole("heading", { name: "Sign in to GladRags" }),
    ).toBeVisible();
  });

  test("opened from the Account sheet, Back goes to the wardrobe and browser Back to where the user was", async ({
    page,
  }) => {
    await page.goto("/wardrobe?category=shoes");
    await page.getByRole("button", { name: "Account" }).click();
    await page
      .getByRole("dialog", { name: "Account" })
      .getByRole("link", { name: "How your photos are handled" })
      .click();
    await expect(page).toHaveURL(/\/privacy$/);
    await expect(page.getByRole("dialog", { name: "Account" })).toHaveCount(0);
    await page.goBack();
    await expect(page).toHaveURL(/\/wardrobe\?category=shoes$/);
    await page.goForward();
    await page.getByRole("link", { name: "Back to GladRags" }).click();
    await expect(page).toHaveURL(/\/wardrobe$/);
  });

  test("no sideways scroll at 390 px, and at 320 px", async ({ page }) => {
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 700 });
      await page.goto("/privacy");
      await expect(
        page.getByRole("heading", { level: 1, name: "Privacy" }),
      ).toBeVisible();
      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      );
      expect(overflow, `overflow at ${width} px`).toBeLessThanOrEqual(0);
    }
  });

  // Mock mode skips the proxy, so these are 404s here. With real auth a
  // signed-out visitor is sent to sign-in instead (/privacy is public by
  // exact path only): see src/proxy.test.ts and src/qa-privacy-proxy.test.ts.
  test("a lookalike path is not the privacy page", async ({ page }) => {
    for (const path of ["/privacyx", "/privacy-policy", "/privacy/anything"]) {
      const res = await page.goto(path);
      expect(res?.status(), path).toBe(404);
    }
  });
});
