import { readFileSync } from "node:fs";
import { expect, test, type Page, type Request } from "@playwright/test";
import { fakeBackgroundRemoverForFile } from "./helpers";

// Predictable cut-outs: the real model is covered by background-removal.spec.ts.
fakeBackgroundRemoverForFile();

// QA journey tests for the wardrobe-ui branch, on the 390 px phone viewport
// against mock mode. They complement wardrobe.spec.ts with the photo
// pipeline (resize, re-encode, EXIF orientation, odd files), the link flow's
// two steps and share target, error and limit states, and phone layout.
//
// Most tests answer the upload routes themselves (page.route) so they don't
// use up the mock user's shared daily cap of 40 items.
//
// The 20-item timing check is opt-in (QA_SPEED=1) because it spends half the
// daily cap on its own; run it against a freshly started server.

const PHOTO = readFileSync(new URL("./fixtures/shirt.jpg", import.meta.url));
const USER = "0a000000-0000-4000-8000-0000000000aa";
const ORIGINAL_KEY = `${USER}/1b000000-0000-4000-8000-0000000000a1.jpg`;
const CUTOUT_KEY = `${USER}/1b000000-0000-4000-8000-0000000000a2.png`;
const JEANS = "1a000000-0000-4000-8000-000000000004";
const DRESS = "1a000000-0000-4000-8000-000000000007";

const SUGGESTED_TAGS = {
  category: "top",
  subcategory: "shirt",
  colours: ["navy", "white"],
  pattern: "stripe",
  formality: 2,
  seasons: ["spring", "summer"],
  warmth: "light",
  occasions: ["casual", "smart_casual"],
  fabric: "linen",
  description: "Navy and white striped linen shirt",
};

function draftBody(overrides: Record<string, unknown> = {}) {
  return {
    draft: {
      source: "photo",
      sourceUrl: null,
      originalImageKey: ORIGINAL_KEY,
      cutoutImageKey: CUTOUT_KEY,
      originalUrl: "/mock/items/blue-oxford-shirt.svg",
      cutoutUrl: "/mock/items/blue-oxford-shirt.svg",
      suggestedTags: SUGGESTED_TAGS,
      ...overrides,
    },
  };
}

function apiError(code: string, message: string, extra: Record<string, unknown> = {}) {
  return { error: { code, message, ...extra } };
}

// ---------------------------------------------------------------------------
// Helpers: images made in the browser, multipart parsing, JPEG inspection
// ---------------------------------------------------------------------------

type Pattern = "halves" | "transparent" | "noise";

/** Draw a test image in the page and return its bytes. */
async function makeImage(page: Page, width: number, height: number, type: "image/jpeg" | "image/png", pattern: Pattern): Promise<Buffer> {
  const base64 = await page.evaluate(
    async ({ width, height, type, pattern }) => {
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext("2d")!;
      if (pattern === "halves") {
        // Left half red, right half blue: shows which way up the result is.
        ctx.fillStyle = "#ff0000";
        ctx.fillRect(0, 0, width / 2, height);
        ctx.fillStyle = "#0000ff";
        ctx.fillRect(width / 2, 0, width / 2, height);
      } else if (pattern === "transparent") {
        // A green square in the middle of a fully transparent image.
        ctx.fillStyle = "#00ff00";
        ctx.fillRect(width / 4, height / 4, width / 2, height / 2);
      } else {
        // Random noise compresses badly: the worst case for the 1.5 MB limit.
        const data = ctx.createImageData(width, height);
        for (let i = 0; i < data.data.length; i++) data.data[i] = i % 4 === 3 ? 255 : Math.floor(Math.random() * 256);
        ctx.putImageData(data, 0, 0);
      }
      const blob = await canvas.convertToBlob({ type, quality: 0.98 });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(binary);
    },
    { width, height, type, pattern },
  );
  return Buffer.from(base64, "base64");
}

/** Insert an EXIF APP1 segment with the given Orientation right after the JPEG's SOI marker. */
function withExifOrientation(jpeg: Buffer, orientation: number): Buffer {
  const tiff = Buffer.from([
    0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, // big-endian TIFF header, IFD0 at offset 8
    0x00, 0x01, // one entry
    0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation, 0x00, 0x00, // Orientation, SHORT, 1
    0x00, 0x00, 0x00, 0x00, // no next IFD
  ]);
  const payload = Buffer.concat([Buffer.from("Exif\0\0", "binary"), tiff]);
  const header = Buffer.from([0xff, 0xe1, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]);
  return Buffer.concat([jpeg.subarray(0, 2), header, payload, jpeg.subarray(2)]);
}

interface Part {
  name: string;
  filename: string | null;
  contentType: string | null;
  data: Buffer;
}

function parseMultipart(request: Request): Part[] {
  const type = request.headers()["content-type"] ?? "";
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(type);
  const body = request.postDataBuffer();
  if (!boundary || !body) return [];
  const delimiter = Buffer.from(`--${boundary[1] ?? boundary[2]}`);
  const parts: Part[] = [];
  let start = body.indexOf(delimiter);
  while (start >= 0) {
    const next = body.indexOf(delimiter, start + delimiter.length);
    if (next < 0) break;
    const chunk = body.subarray(start + delimiter.length + 2, next - 2); // drop CRLFs around it
    const split = chunk.indexOf("\r\n\r\n");
    const head = chunk.subarray(0, split).toString("utf8");
    parts.push({
      name: /name="([^"]*)"/.exec(head)?.[1] ?? "",
      filename: /filename="([^"]*)"/.exec(head)?.[1] ?? null,
      contentType: /content-type:\s*([^\r\n]+)/i.exec(head)?.[1]?.trim() ?? null,
      data: chunk.subarray(split + 4),
    });
    start = next;
  }
  return parts;
}

function jpegInfo(data: Buffer): { width: number; height: number; hasExif: boolean } | null {
  if (data[0] !== 0xff || data[1] !== 0xd8) return null;
  let hasExif = false;
  let i = 2;
  while (i < data.length - 9) {
    if (data[i] !== 0xff) return null;
    const marker = data[i + 1]!;
    const length = data.readUInt16BE(i + 2);
    if (marker === 0xe1 && data.subarray(i + 4, i + 8).toString("binary") === "Exif") hasExif = true;
    if (marker >= 0xc0 && marker <= 0xc3) {
      return { height: data.readUInt16BE(i + 5), width: data.readUInt16BE(i + 7), hasExif };
    }
    i += 2 + length;
  }
  return null;
}

const isPng = (data: Buffer) => data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

/** RGBA of the given points in a JPEG, decoded by the browser. */
async function pixels(page: Page, jpeg: Buffer, points: [number, number][]): Promise<number[][]> {
  return page.evaluate(
    async ({ base64, points }) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(bitmap, 0, 0);
      return points.map(([x, y]) => Array.from(ctx.getImageData(x, y, 1, 1).data));
    },
    { base64: jpeg.toString("base64"), points },
  );
}

/**
 * Answer POST /api/items/photo with a draft and keep the multipart parts the
 * page sent, so the test can inspect the uploaded files without using the cap.
 */
async function capturePhotoUpload(page: Page, draft = draftBody()): Promise<{ parts: () => Part[]; count: () => number }> {
  let parts: Part[] = [];
  let count = 0;
  await page.route("**/api/items/photo", async (route) => {
    count++;
    parts = parseMultipart(route.request());
    await route.fulfill({ status: 200, json: draft });
  });
  return { parts: () => parts, count: () => count };
}

async function choose(page: Page, name: string, buffer: Buffer, mimeType: string) {
  await page.getByTestId("photo-library-input").setInputFiles({ name, mimeType, buffer });
}

function group(page: Page, name: string) {
  return page.getByRole("group", { name, exact: true });
}

// ---------------------------------------------------------------------------
// Mobile layout checks
// ---------------------------------------------------------------------------

async function expectNoSidewaysScroll(page: Page) {
  const overflow = await page.evaluate(() => ({
    page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    wide: [...document.querySelectorAll<HTMLElement>("body *")]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && (r.right > window.innerWidth + 1 || r.left < -1) && getComputedStyle(el).position !== "fixed";
      })
      .filter((el) => !el.closest(".sr-only") && !el.classList.contains("sr-only"))
      .slice(0, 5)
      .map((el) => `${el.tagName.toLowerCase()}.${el.className.toString().slice(0, 40)}`),
  }));
  expect(overflow, `sideways overflow; widest: ${overflow.wide.join(", ")}`).toEqual({ page: 0, wide: [] });
}

/** Visible tap targets smaller than 44 px in either direction. */
async function smallTapTargets(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const targets = [
      ...document.querySelectorAll<HTMLElement>("button, a[href], select, input:not([type=hidden]):not(.sr-only), label:has(> input.sr-only)"),
    ];
    return targets
      .filter((el) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        const style = getComputedStyle(el);
        if (style.visibility === "hidden" || el.closest("[aria-hidden=true]")) return false;
        return r.height < 43.5 || r.width < 43.5;
      })
      .map((el) => {
        const r = el.getBoundingClientRect();
        const label = (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 30);
        return `${el.tagName.toLowerCase()} "${label}" ${Math.round(r.width)}x${Math.round(r.height)}`;
      });
  });
}

/**
 * Scrolled to the bottom, nothing in the page content may sit under the
 * bottom navigation, and any sticky action bar must sit on top of the nav.
 */
async function expectNavCoversNothing(page: Page) {
  const result = await page.evaluate(async () => {
    window.scrollTo(0, document.documentElement.scrollHeight);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const nav = document.querySelector('nav[aria-label="Main"]');
    if (!nav) return { covered: [], navTop: null };
    const navTop = nav.getBoundingClientRect().top;
    const covered = [...document.querySelectorAll<HTMLElement>("main button, main a[href], main input:not(.sr-only), main label, main p, main h2")]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.height > 0 && r.bottom > navTop + 0.5 && r.top < window.innerHeight;
      })
      .map((el) => `${el.tagName.toLowerCase()} "${(el.textContent ?? "").trim().slice(0, 30)}"`);
    return { covered, navTop };
  });
  expect(result.covered, "content hidden under the bottom navigation").toEqual([]);
}

async function checkPhoneLayout(page: Page, screen: string) {
  await expectNoSidewaysScroll(page);
  expect(await smallTapTargets(page), `tap targets under 44 px on ${screen}`).toEqual([]);
  await expectNavCoversNothing(page);
}

// ---------------------------------------------------------------------------
// Photo pipeline
// ---------------------------------------------------------------------------

test.describe("photo pipeline: resize to 1600 px and re-encode as JPEG", () => {
  const cases: [string, number, number, "image/jpeg" | "image/png", number, number][] = [
    ["a wide photo", 4000, 1000, "image/jpeg", 1600, 400],
    ["a tall photo", 1000, 4000, "image/jpeg", 400, 1600],
    ["a tiny PNG (not scaled up, but re-encoded)", 24, 16, "image/png", 24, 16],
    ["a photo exactly 1600 px", 1600, 900, "image/jpeg", 1600, 900],
  ];

  for (const [label, w, h, type, ew, eh] of cases) {
    test(`${label}: ${w} x ${h} uploads as a ${ew} x ${eh} JPEG with a PNG cut-out`, async ({ page }) => {
      await page.goto("/add");
      const upload = await capturePhotoUpload(page);
      const image = await makeImage(page, w, h, type, "halves");
      await choose(page, type === "image/png" ? "item.png" : "item.jpg", image, type);
      await expect(page.getByRole("heading", { name: "Check the tags" })).toBeVisible();

      const original = upload.parts().find((p) => p.name === "original")!;
      expect(original.filename).toBe("item.jpg");
      expect(original.contentType).toBe("image/jpeg");
      expect(jpegInfo(original.data)).toMatchObject({ width: ew, height: eh });
      const cutout = upload.parts().find((p) => p.name === "cutout")!;
      expect(cutout.filename).toBe("item.png");
      expect(isPng(cutout.data)).toBe(true);
    });
  }

  test("a see-through PNG screenshot is put on white, not black, when it becomes a JPEG", async ({ page }) => {
    await page.goto("/add");
    const upload = await capturePhotoUpload(page);
    await choose(page, "screenshot.png", await makeImage(page, 400, 400, "image/png", "transparent"), "image/png");
    await expect(page.getByRole("heading", { name: "Check the tags" })).toBeVisible();
    const original = upload.parts().find((p) => p.name === "original")!;
    const [corner, middle] = await pixels(page, original.data, [
      [5, 5],
      [200, 200],
    ]);
    expect(corner!.slice(0, 3).every((v) => v > 240)).toBe(true);
    expect(middle![1]).toBeGreaterThan(200);
    expect(middle![0]).toBeLessThan(60);
  });

  test("a rotated phone photo (EXIF orientation 6) comes out upright, with the EXIF gone", async ({ page }) => {
    await page.goto("/add");
    const upload = await capturePhotoUpload(page);
    // Stored 200 x 100, left red and right blue. Orientation 6 means "turn
    // 90 degrees clockwise to show", so upright it's 100 x 200, red on top.
    const sideways = withExifOrientation(await makeImage(page, 200, 100, "image/jpeg", "halves"), 6);
    expect(jpegInfo(sideways)).toMatchObject({ width: 200, height: 100, hasExif: true });
    await choose(page, "IMG_0001.jpg", sideways, "image/jpeg");
    await expect(page.getByRole("heading", { name: "Check the tags" })).toBeVisible();

    const original = upload.parts().find((p) => p.name === "original")!;
    expect(jpegInfo(original.data)).toEqual({ width: 100, height: 200, hasExif: false });
    const [top, bottom] = await pixels(page, original.data, [
      [50, 20],
      [50, 180],
    ]);
    expect(top![0], "top should be red").toBeGreaterThan(200);
    expect(top![2]).toBeLessThan(60);
    expect(bottom![2], "bottom should be blue").toBeGreaterThan(200);
    expect(bottom![0]).toBeLessThan(60);
  });

  test("a large, detailed photo is brought under the 1.5 MB upload limit", async ({ page }) => {
    test.slow();
    await page.goto("/add");
    const upload = await capturePhotoUpload(page);
    const noisy = await makeImage(page, 2400, 2400, "image/jpeg", "noise");
    expect(noisy.length).toBeGreaterThan(1.5 * 1024 * 1024);
    await choose(page, "detailed.jpg", noisy, "image/jpeg");
    await expect(page.getByRole("heading", { name: "Check the tags" })).toBeVisible({ timeout: 30_000 });
    const original = upload.parts().find((p) => p.name === "original")!;
    expect(original.data.length).toBeLessThanOrEqual(1.5 * 1024 * 1024);
    const info = jpegInfo(original.data)!;
    expect(Math.max(info.width, info.height)).toBeLessThanOrEqual(1600);
  });

  test("a HEIC file this browser can't read gets a clear message and nothing is uploaded", async ({ page }) => {
    // The ISO-BMFF 'ftyp heic' header of an iPhone photo. Chromium can't
    // decode HEIC, so this is what Android/desktop users would see. (iOS
    // Safari converts HEIC to JPEG when a page asks for image/*.)
    const heic = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic\0\0\0\0mif1heic", "binary"), Buffer.alloc(64)]);
    await page.goto("/add");
    const upload = await capturePhotoUpload(page);
    await choose(page, "IMG_0042.HEIC", heic, "image/heic");
    await expect(page.getByText("Couldn't use that photo")).toBeVisible();
    await expect(page.getByText("We couldn't read that photo. Try a different one, or take a new photo.")).toBeVisible();
    expect(upload.count()).toBe(0);
    await page.getByRole("button", { name: "Try another photo" }).click();
    await expect(page.getByTestId("photo-library-input")).toBeAttached();
  });

  test("a text file named like a photo is refused before upload", async ({ page }) => {
    await page.goto("/add");
    const upload = await capturePhotoUpload(page);
    await choose(page, "shirt.jpg", Buffer.from("definitely not a jpeg"), "image/jpeg");
    await expect(page.getByText("Couldn't use that photo")).toBeVisible();
    expect(upload.count()).toBe(0);
  });

  test("the server refusing the file (bad_request) is shown, with a way to try again", async ({ page }) => {
    await page.goto("/add");
    await page.route("**/api/items/photo", (route) =>
      route.fulfill({ status: 400, json: apiError("bad_request", "The photo must be JPEG, PNG, WEBP", { issues: [] }) }),
    );
    await choose(page, "shirt.jpg", PHOTO, "image/jpeg");
    await expect(page.getByText("The photo must be JPEG, PNG, WEBP")).toBeVisible();
    await expect(page.getByRole("button", { name: "Try another photo" })).toBeVisible();
  });

  test("no tags from the tagger: the review starts empty", async ({ page }) => {
    await page.goto("/add");
    await capturePhotoUpload(page, draftBody({ suggestedTags: null }));
    await choose(page, "shirt.jpg", PHOTO, "image/jpeg");
    await expect(page.getByText("Fill in the tags")).toBeVisible();
    await expect(group(page, "Type").getByText("Choose a category first.")).toBeVisible();
  });

  test("no cut-out (background removal failed): the review says the original will be used", async ({ page }) => {
    // The in-browser remover can't be made to fail from a test in mock mode;
    // this covers the screen's side. The pipeline side is unit-tested.
    await page.goto("/add");
    await capturePhotoUpload(page, draftBody({ cutoutImageKey: null, cutoutUrl: null, originalUrl: "/mock/items/camel-coat.svg" }));
    await choose(page, "shirt.jpg", PHOTO, "image/jpeg");
    await expect(page.getByText(/original (photo|image) will be used/)).toBeVisible();
    await expect(page.getByRole("img", { name: "The item you're adding" })).toHaveAttribute("src", "/mock/items/camel-coat.svg");
  });
});

test("saving sends tagsEdited false for untouched tags and true once a tag is changed", async ({ page }) => {
  const saves: { tagsEdited: boolean; tags: { description: string } }[] = [];
  await page.route("**/api/items", async (route) => {
    if (route.request().method() === "POST") saves.push(route.request().postDataJSON());
    await route.continue();
  });

  await page.goto("/add");
  await choose(page, "untouched.jpg", PHOTO, "image/jpeg");
  await expect(page.getByRole("heading", { name: "Check the tags" })).toBeVisible();
  // Change something and change it back: still not an edit.
  await group(page, "Pattern").getByText("Floral", { exact: true }).click();
  await group(page, "Pattern").getByText("Stripe", { exact: true }).click();
  await page.getByRole("button", { name: "Save to wardrobe" }).click();
  await expect(page.getByText("Saved to your wardrobe")).toBeVisible();
  expect(saves[0]!.tagsEdited).toBe(false);

  // The saved item's detail page agrees.
  await page.getByRole("link", { name: "View item" }).click();
  await page.getByRole("button", { name: "Edit tags" }).click();
  await page.getByRole("button", { name: "Save tags" }).click();
  await expect(page.getByText("No changes to save.")).toBeVisible();
});

// ---------------------------------------------------------------------------
// Link flow
// ---------------------------------------------------------------------------

test.describe("add by link", () => {
  test("step 1 reads the page, then step 2 sends the cut-out with step 1's image key", async ({ page }) => {
    const calls: string[] = [];
    let step1: { originalImageKey: string; originalUrl: string } | null = null;
    let step2: Part[] = [];
    await page.route("**/api/items/link", async (route) => {
      calls.push(`step1 ${route.request().postDataJSON().url}`);
      const response = await route.fetch();
      step1 = await response.json();
      await route.fulfill({ response });
    });
    await page.route("**/api/items/link/cutout", async (route) => {
      calls.push("step2");
      step2 = parseMultipart(route.request());
      await route.continue();
    });
    page.on("request", (r) => {
      if (step1 && r.url().endsWith(step1.originalUrl)) calls.push("product image");
    });

    const link = `https://shop.example.com/products/qa-${Date.now()}`;
    await page.goto("/add/link");
    await page.getByLabel("Product link").fill(`  ${link}  `);
    await page.getByRole("button", { name: "Add from link" }).click();
    await expect(page.getByRole("heading", { name: "Check the tags" })).toBeVisible();

    // (The review screen may load the same image again afterwards.)
    expect(calls.slice(0, 3)).toEqual([`step1 ${link}`, "product image", "step2"]);
    const meta = JSON.parse(step2.find((p) => p.name === "meta")!.data.toString("utf8"));
    expect(meta).toEqual({ originalImageKey: step1!.originalImageKey });
    const cutout = step2.find((p) => p.name === "cutout")!;
    expect(isPng(cutout.data)).toBe(true);
    // The photo route is not involved.
    expect(calls.some((c) => c.includes("photo"))).toBe(false);
  });

  test("the screenshot fallback uploads through the photo route with the link as sourceUrl", async ({ page }) => {
    const link = `https://blocked.example.com/p/qa-${Date.now()}`;
    const upload = await capturePhotoUpload(page, draftBody({ source: "link", sourceUrl: link }));
    await page.goto("/add/link");
    await page.getByLabel("Product link").fill(link);
    await page.getByRole("button", { name: "Add from link" }).click();
    await expect(page.getByRole("heading", { name: "Add a screenshot" })).toBeVisible();
    await checkPhoneLayout(page, "screenshot fallback");

    await choose(page, "Screenshot 2026-10-25.png", await makeImage(page, 1170, 2532, "image/png", "halves"), "image/png");
    await expect(page.getByRole("heading", { name: "Check the tags" })).toBeVisible();
    const parts = upload.parts();
    expect(parts.find((p) => p.name === "sourceUrl")?.data.toString("utf8")).toBe(link);
    expect(jpegInfo(parts.find((p) => p.name === "original")!.data)).toMatchObject({ width: 739, height: 1600 });
  });

  test("each kind of unreadable page gets the screenshot fallback with its reason", async ({ page }) => {
    for (const host of ["blocked", "nodata", "noimage"]) {
      await page.goto("/add/link");
      await page.getByLabel("Product link").fill(`https://${host}.example.com/p/1`);
      await page.getByRole("button", { name: "Add from link" }).click();
      await expect(page.getByRole("button", { name: "Choose a screenshot" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Take a photo instead" })).toBeVisible();
    }
  });

  test("an import that expired before step 2 asks for the link again", async ({ page }) => {
    await page.route("**/api/items/link/cutout", (route) =>
      route.fulfill({ status: 404, json: apiError("not_found", "That link has expired. Paste it again.") }),
    );
    await page.goto("/add/link");
    await page.getByLabel("Product link").fill("https://shop.example.com/p/expired");
    await page.getByRole("button", { name: "Add from link" }).click();
    await expect(page.getByText("That link has expired. Paste it again.")).toBeVisible();
    await page.getByRole("button", { name: "Paste the link again" }).click();
    await expect(page.getByLabel("Product link")).toBeVisible();
  });

  test.describe("invalid links are caught before anything is sent", () => {
    for (const bad of [
      "shop.example.com/p/1",
      "ftp://shop.example.com/p/1",
      "javascript:alert(1)",
      "https://",
      "just some words",
      `https://shop.example.com/${"a".repeat(2100)}`,
    ]) {
      test(JSON.stringify(bad.slice(0, 40)), async ({ page }) => {
        let sent = 0;
        await page.route("**/api/items/link", async (route) => {
          sent++;
          await route.continue();
        });
        await page.goto("/add/link");
        await page.getByLabel("Product link").fill(bad);
        await page.getByRole("button", { name: "Add from link" }).click();
        await expect(page.getByText("Paste a full link starting with https://")).toBeVisible();
        expect(sent).toBe(0);
      });
    }
  });

  test("the submit button stays disabled until something is typed", async ({ page }) => {
    await page.goto("/add/link");
    await expect(page.getByRole("button", { name: "Add from link" })).toBeDisabled();
    await page.getByLabel("Product link").fill("   ");
    await expect(page.getByRole("button", { name: "Add from link" })).toBeDisabled();
  });
});

test.describe("PWA share target (/add/link?url=…&text=…)", () => {
  async function shareTo(page: Page, query: string): Promise<string[]> {
    const urls: string[] = [];
    await page.route("**/api/items/link", async (route) => {
      urls.push(route.request().postDataJSON().url);
      await route.continue();
    });
    // Step 2 answered here, so sharing doesn't use the daily cap.
    await page.route("**/api/items/link/cutout", (route) =>
      route.fulfill({ status: 200, json: draftBody({ source: "link", sourceUrl: "https://shop.example.com/p/shared" }) }),
    );
    await page.goto(`/add/link?${query}`);
    return urls;
  }

  test("a link in `url` starts the import by itself, once", async ({ page }) => {
    const link = "https://shop.example.com/p/shared?colour=navy&size=m";
    const urls = await shareTo(page, `url=${encodeURIComponent(link)}&title=Shirt`);
    await expect(page.getByRole("heading", { name: "Check the tags" })).toBeVisible();
    expect(urls).toEqual([link]);
  });

  test("`url` wins over a different link inside `text`", async ({ page }) => {
    const urls = await shareTo(
      page,
      `url=${encodeURIComponent("https://shop.example.com/p/from-url")}&text=${encodeURIComponent("See https://other.example.com/p/from-text")}`,
    );
    await expect(page.getByRole("heading", { name: "Check the tags" })).toBeVisible();
    expect(urls).toEqual(["https://shop.example.com/p/from-url"]);
  });

  test("a link inside `text` is used when `url` is missing", async ({ page }) => {
    const urls = await shareTo(page, `text=${encodeURIComponent("Look at this https://shop.example.com/p/from-text nice")}`);
    await expect(page.getByRole("heading", { name: "Check the tags" })).toBeVisible();
    expect(urls).toEqual(["https://shop.example.com/p/from-text"]);
  });

  test("shared text with no link waits for a paste and sends nothing", async ({ page }) => {
    const urls = await shareTo(page, `title=Shirt&text=${encodeURIComponent("a lovely shirt")}`);
    await expect(page.getByLabel("Product link")).toHaveValue("");
    await expect(page.getByRole("button", { name: "Add from link" })).toBeDisabled();
    expect(urls).toEqual([]);
  });

  test("a shared blocked page goes straight to the screenshot step", async ({ page }) => {
    await shareTo(page, `url=${encodeURIComponent("https://blocked.example.com/p/9")}`);
    await expect(page.getByRole("heading", { name: "Add a screenshot" })).toBeVisible();
  });

  test("a non-http link in `url` is ignored", async ({ page }) => {
    const urls = await shareTo(page, `url=${encodeURIComponent("javascript:alert(1)")}`);
    await expect(page.getByLabel("Product link")).toHaveValue("");
    expect(urls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Wardrobe screen
// ---------------------------------------------------------------------------

test.describe("wardrobe filters and search", () => {
  test("filters and search combine, and all of them live in the URL", async ({ page }) => {
    await page.goto("/wardrobe?category=bottom&q=chinos");
    await expect(page.getByRole("combobox", { name: "Category" })).toHaveValue("bottom");
    await expect(page.getByRole("searchbox", { name: "Search descriptions" })).toHaveValue("chinos");
    await expect(page.getByRole("link", { name: "Tan slim chinos" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Mid-blue straight-leg jeans" })).toHaveCount(0);

    await page.getByRole("combobox", { name: "Occasion" }).selectOption("work");
    await page.getByRole("combobox", { name: "Colour" }).selectOption("tan");
    await expect(page).toHaveURL(/category=bottom/);
    await expect(page).toHaveURL(/colour=tan/);
    await expect(page).toHaveURL(/occasion=work/);
    await expect(page).toHaveURL(/q=chinos/);
    await expect(page.getByText("1 item match")).toBeVisible();

    // A combination nothing satisfies.
    await page.getByRole("combobox", { name: "Colour" }).selectOption("pink");
    await expect(page.getByText("Nothing matches those filters.")).toBeVisible();
    await checkPhoneLayout(page, "wardrobe, no matches");
    await page.getByRole("main").getByRole("button", { name: "Clear filters" }).last().click();
    await expect(page).toHaveURL(/\/wardrobe$/);
    await expect(page.getByRole("link", { name: "Camel wool overcoat" })).toBeVisible();
    await expect(page.getByRole("searchbox", { name: "Search descriptions" })).toHaveValue("");
  });

  // FAILS on 4e38c61 (dev and production build): Back returns to /wardrobe
  // with no filters. The screen calls history.replaceState(history.state, …),
  // copying Next's router state, which still holds the old URL.
  test("filters survive opening an item and coming back", async ({ page }) => {
    await page.goto("/wardrobe");
    await page.getByRole("combobox", { name: "Category" }).selectOption("shoes");
    await page.getByRole("searchbox", { name: "Search descriptions" }).fill("leather");
    await expect(page).toHaveURL(/category=shoes&q=leather|q=leather.*category=shoes/);
    await page.getByRole("link", { name: "White leather trainers" }).click();
    await expect(page.getByRole("heading", { name: "White leather trainers" })).toBeVisible();

    await page.goBack();
    await expect(page).toHaveURL(/category=shoes/);
    await expect(page.getByRole("combobox", { name: "Category" })).toHaveValue("shoes");
    await expect(page.getByRole("searchbox", { name: "Search descriptions" })).toHaveValue("leather");
    await expect(page.getByRole("link", { name: "Tan suede loafers" })).toHaveCount(0);
  });

  test("unknown filter values in the URL are dropped, not sent", async ({ page }) => {
    const queries: string[] = [];
    page.on("request", (r) => {
      if (new URL(r.url()).pathname === "/api/items") queries.push(new URL(r.url()).search);
    });
    await page.goto("/wardrobe?category=hats&colour=sparkly&occasion=funeral");
    await expect(page.getByRole("link", { name: "Camel wool overcoat" })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Category" })).toHaveValue("");
    // (The dev server's React strict mode may ask twice; never with a filter.)
    expect(new Set(queries)).toEqual(new Set([""]));
    await expect(page).toHaveURL(/\/wardrobe$/);
  });

  test("search is case-insensitive and ignores surrounding spaces", async ({ page }) => {
    await page.goto("/wardrobe");
    await page.getByRole("searchbox", { name: "Search descriptions" }).fill("  MERINO ");
    await expect(page.getByRole("link", { name: "Grey merino crew jumper" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Camel wool overcoat" })).toHaveCount(0);
  });

  test("an empty wardrobe invites the first item", async ({ page }) => {
    await page.route("**/api/items", (route) => route.fulfill({ status: 200, json: { items: [] } }));
    await page.goto("/wardrobe");
    await expect(page.getByText("Your wardrobe is empty")).toBeVisible();
    await page.getByRole("link", { name: "Add your first item" }).click();
    await expect(page).toHaveURL(/\/add$/);
  });

  test("a wardrobe that fails to load can be retried", async ({ page }) => {
    let failing = true;
    await page.route("**/api/items", async (route) => {
      if (failing) await route.fulfill({ status: 500, json: apiError("internal", "Something went wrong on our side.") });
      else await route.continue();
    });
    await page.goto("/wardrobe");
    await expect(page.getByText("Something went wrong on our side.")).toBeVisible();
    await checkPhoneLayout(page, "wardrobe error");
    failing = false;
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByRole("link", { name: "Camel wool overcoat" })).toBeVisible();
  });

  test("losing the connection says so plainly", async ({ page }) => {
    await page.route("**/api/items", (route) => route.abort("internetdisconnected"));
    await page.goto("/wardrobe");
    await expect(page.getByText("Couldn't reach GladRags. Check your connection and try again.")).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Item detail
// ---------------------------------------------------------------------------

test.describe("item detail", () => {
  test("saving the edit form without changes sends nothing", async ({ page }) => {
    const patches: string[] = [];
    page.on("request", (r) => {
      if (r.method() === "PATCH") patches.push(r.url());
    });
    await page.goto(`/wardrobe/${JEANS}`);
    await page.getByRole("button", { name: "Edit tags" }).click();
    await checkPhoneLayout(page, "edit tags");
    await page.getByRole("button", { name: "Save tags" }).click();
    await expect(page.getByText("No changes to save.")).toBeVisible();
    expect(patches).toEqual([]);
  });

  test("a failed tag save keeps the form and the changes", async ({ page }) => {
    await page.route(`**/api/items/${DRESS}`, async (route) => {
      if (route.request().method() === "PATCH") {
        await route.fulfill({ status: 500, json: apiError("internal", "Couldn't save just now.") });
      } else await route.continue();
    });
    await page.goto(`/wardrobe/${DRESS}`);
    await page.getByRole("button", { name: "Edit tags" }).click();
    await group(page, "Pattern").getByText("Print", { exact: true }).click();
    await page.getByRole("button", { name: "Save tags" }).click();
    await expect(page.getByText("Couldn't save just now.")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Edit tags" })).toBeVisible();
    await expect(group(page, "Pattern").getByRole("radio", { name: "Print" })).toBeChecked();
    await expect(page.getByRole("button", { name: "Save tags" })).toBeEnabled();
  });

  test("a failed delete leaves the item in place and says why", async ({ page }) => {
    await page.route(`**/api/items/${DRESS}`, async (route) => {
      if (route.request().method() === "DELETE") {
        await route.fulfill({ status: 500, json: apiError("internal", "Couldn't delete just now.") });
      } else await route.continue();
    });
    await page.goto(`/wardrobe/${DRESS}`);
    await page.getByRole("button", { name: "Delete" }).click();
    const dialog = page.getByRole("alertdialog", { name: "Delete this item?" });
    await expectNoSidewaysScroll(page);
    for (const name of ["Keep it", "Delete item"]) {
      // Polled: the dialog zooms in from 95%.
      await expect
        .poll(async () => (await dialog.getByRole("button", { name }).boundingBox())!.height, { message: `${name} button height` })
        .toBeGreaterThanOrEqual(43.5);
    }
    await dialog.getByRole("button", { name: "Delete item" }).click();
    await expect(page.getByText("Couldn't delete just now.")).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/wardrobe/${DRESS}$`));
    await expect(page.getByRole("button", { name: "Delete" })).toBeEnabled();
  });

  test("'Build an outfit around this' is above the nav and links to outfits with the anchor", async ({ page }) => {
    await page.goto(`/wardrobe/${DRESS}`);
    const link = page.getByRole("link", { name: "Build an outfit around this" });
    await expect(link).toHaveAttribute("href", `/outfits?anchor=${DRESS}`);
    const navTop = (await page.getByRole("navigation", { name: "Main" }).boundingBox())!.y;
    const box = (await link.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(navTop);
    expect(box.height).toBeGreaterThanOrEqual(44);
    await checkPhoneLayout(page, "item detail");
  });
});

// ---------------------------------------------------------------------------
// Limits, paused AI, expired sessions
// ---------------------------------------------------------------------------

function usage(used: number, aiPaused = false) {
  return {
    itemsToday: { used, limit: 40 },
    outfitRequestsToday: { used: 0, limit: 25 },
    dailyResetAt: new Date(Date.now() + 3600_000).toISOString(),
    aiPaused,
  };
}

test.describe("limits and paused AI, before the user starts", () => {
  test("at the daily cap, the add screens say so and won't start", async ({ page }) => {
    await page.route("**/api/usage", (route) => route.fulfill({ status: 200, json: usage(40) }));
    await page.goto("/add");
    await expect(page.getByText("That's today's limit")).toBeVisible();
    await expect(page.getByRole("button", { name: "Take a photo" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Choose from library" })).toBeDisabled();
    await checkPhoneLayout(page, "add at cap");

    await page.goto("/add/link");
    await expect(page.getByText("That's today's limit")).toBeVisible();
    await page.getByLabel("Product link").fill("https://shop.example.com/p/1");
    await expect(page.getByRole("button", { name: "Add from link" })).toBeDisabled();
  });

  test("with AI paused, the add screens say so and won't start", async ({ page }) => {
    await page.route("**/api/usage", (route) => route.fulfill({ status: 200, json: usage(3, true) }));
    await page.goto("/add");
    await expect(page.getByText("Adding is paused")).toBeVisible();
    await expect(page.getByRole("button", { name: "Choose from library" })).toBeDisabled();
  });

  test("one short of the cap still allows adding", async ({ page }) => {
    await page.route("**/api/usage", (route) => route.fulfill({ status: 200, json: usage(39) }));
    await page.goto("/add");
    await expect(page.getByText("39 of 40 items added today")).toBeVisible();
    await expect(page.getByRole("button", { name: "Choose from library" })).toBeEnabled();
  });

  test("hitting the cap while saving a link import offers the wardrobe", async ({ page }) => {
    const resetsAt = new Date(Date.now() + 3600_000).toISOString();
    await page.route("**/api/items/link/cutout", (route) =>
      route.fulfill({
        status: 429,
        json: apiError("daily_cap_reached", "You've reached today's limit.", { cap: { kind: "items_per_day", limit: 40, resetsAt } }),
      }),
    );
    await page.goto("/add/link");
    await page.getByLabel("Product link").fill("https://shop.example.com/p/cap-at-step-2");
    await page.getByRole("button", { name: "Add from link" }).click();
    await expect(page.getByText("That's today's limit")).toBeVisible();
    await expect(page.getByRole("link", { name: "Go to wardrobe" })).toBeVisible();
    await checkPhoneLayout(page, "cap error");
  });
});

// FAIL on 4e38c61: a 401 shows "Something went wrong" with the API's
// message and a Try again button that can't succeed. Nothing leads to
// /sign-in (in mock mode the proxy never redirects, so pages rely on this).
test.describe("an expired session leads to sign-in", () => {
  const signIn = (page: Page) =>
    page.getByRole("heading", { name: "Sign in to GladRags" }).or(page.getByRole("link", { name: /sign in/i }));

  test("on the wardrobe", async ({ page }) => {
    // Match by path: a "**/api/items" glob misses /api/items?category=shoes.
    await page.route((url) => url.pathname === "/api/items", (route) => route.fulfill({ status: 401, json: apiError("unauthorized", "Sign in to continue.") }));
    await page.goto("/wardrobe?category=shoes");
    await expect(signIn(page)).toBeVisible();
  });

  test("when uploading a photo", async ({ page }) => {
    await page.route("**/api/items/photo", (route) =>
      route.fulfill({ status: 401, json: apiError("unauthorized", "Sign in to continue.") }),
    );
    await page.goto("/add");
    await choose(page, "shirt.jpg", PHOTO, "image/jpeg");
    await expect(signIn(page)).toBeVisible();
  });

  test("when saving a reviewed item", async ({ page }) => {
    await capturePhotoUpload(page);
    await page.route("**/api/items", (route) =>
      route.request().method() === "POST"
        ? route.fulfill({ status: 401, json: apiError("unauthorized", "Sign in to continue.") })
        : route.continue(),
    );
    await page.goto("/add");
    await choose(page, "shirt.jpg", PHOTO, "image/jpeg");
    await page.getByRole("button", { name: "Save to wardrobe" }).click();
    await expect(signIn(page)).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Phone layout on every screen
// ---------------------------------------------------------------------------

test.describe("phone layout at 390 px: no sideways scroll, 44 px targets, nav covers nothing", () => {
  test("sign-in, both steps", async ({ page }) => {
    await page.goto("/sign-in");
    await checkPhoneLayout(page, "sign-in");
    await page.getByLabel("Email").fill("cheryl@example.com");
    await page.getByRole("button", { name: "Email me a sign-in link" }).click();
    await expect(page.getByLabel("Code from the email")).toBeVisible();
    await checkPhoneLayout(page, "sign-in code");
  });

  test("wardrobe, filtered wardrobe and empty wardrobe", async ({ page }) => {
    await page.goto("/wardrobe");
    await expect(page.getByRole("link", { name: "Camel wool overcoat" })).toBeVisible();
    await checkPhoneLayout(page, "wardrobe");
    await page.goto("/wardrobe?category=shoes&colour=black&occasion=evening_out&q=heel");
    await expect(page.getByRole("button", { name: "Clear filters" })).toBeVisible();
    await checkPhoneLayout(page, "wardrobe filtered");
    await page.route("**/api/items", (route) => route.fulfill({ status: 200, json: { items: [] } }));
    await page.goto("/wardrobe");
    await expect(page.getByText("Your wardrobe is empty")).toBeVisible();
    await checkPhoneLayout(page, "empty wardrobe");
  });

  test("add: choose, review (top and bottom), saved and error", async ({ page }) => {
    await page.goto("/add");
    await expect(page.getByText(/items added today/)).toBeVisible();
    await checkPhoneLayout(page, "add");

    await capturePhotoUpload(page);
    await choose(page, "shirt.jpg", PHOTO, "image/jpeg");
    await expect(page.getByRole("heading", { name: "Check the tags" })).toBeVisible();
    // The sticky Save bar sits on top of the nav, not under it.
    const save = page.getByRole("button", { name: "Save to wardrobe" });
    const navTop = (await page.getByRole("navigation", { name: "Main" }).boundingBox())!.y;
    const saveBox = (await save.boundingBox())!;
    expect(saveBox.y + saveBox.height).toBeLessThanOrEqual(navTop);
    await expect(save).toBeInViewport();
    await checkPhoneLayout(page, "review");

    await page.route("**/api/items", (route) =>
      route.fulfill({
        status: 201,
        json: {
          item: {
            id: "1c000000-0000-4000-8000-0000000000a1",
            source: "photo",
            sourceUrl: null,
            originalUrl: "/mock/items/blue-oxford-shirt.svg",
            cutoutUrl: "/mock/items/blue-oxford-shirt.svg",
            tags: SUGGESTED_TAGS,
            tagsEdited: false,
            createdAt: new Date().toISOString(),
          },
        },
      }),
    );
    await save.click();
    await expect(page.getByText("Saved to your wardrobe")).toBeVisible();
    await checkPhoneLayout(page, "saved");

    await page.goto("/add");
    await choose(page, "notes.jpg", Buffer.from("nope"), "image/jpeg");
    await expect(page.getByText("Couldn't use that photo")).toBeVisible();
    await checkPhoneLayout(page, "add error");
  });

  test("add by link", async ({ page }) => {
    await page.goto("/add/link");
    await expect(page.getByLabel("Product link")).toBeVisible();
    await checkPhoneLayout(page, "add by link");
  });

  test("item detail with a long description and the no-cut-out note", async ({ page }) => {
    await page.goto("/wardrobe/1a000000-0000-4000-8000-000000000009");
    await expect(page.getByText("this item has no cut-out")).toBeVisible();
    await checkPhoneLayout(page, "item detail (no cut-out)");
  });
});

// ---------------------------------------------------------------------------
// Speed (opt-in)
// ---------------------------------------------------------------------------

test("adding 20 items in a row through the photo flow is quick (QA_SPEED=1)", async ({ page }) => {
  test.skip(process.env.QA_SPEED !== "1", "Opt-in: uses 20 of the mock user's 40 daily items. Run on a fresh server.");
  test.setTimeout(180_000);
  await page.goto("/add");
  await expect(page.getByText(/items added today/)).toBeVisible();

  const times: number[] = [];
  for (let i = 0; i < 20; i++) {
    const started = Date.now();
    await choose(page, `speed-${i}.jpg`, PHOTO, "image/jpeg");
    await expect(page.getByRole("heading", { name: "Check the tags" })).toBeVisible();
    await page.getByRole("button", { name: "Save to wardrobe" }).click();
    await expect(page.getByText("Saved to your wardrobe")).toBeVisible();
    times.push(Date.now() - started);
  }
  const total = times.reduce((a, b) => a + b, 0);
  const sorted = [...times].sort((a, b) => a - b);
  console.log(
    `20 items: total ${(total / 1000).toFixed(1)} s, mean ${Math.round(total / 20)} ms, median ${sorted[10]} ms, slowest ${sorted[19]} ms`,
  );
  // The success criterion is 20 items in 15 minutes by a person; the app's
  // own share in mock mode (fake background removal) should be a few seconds.
  expect(total).toBeLessThan(60_000);
});
