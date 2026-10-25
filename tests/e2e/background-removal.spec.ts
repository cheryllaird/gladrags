import { expect, test } from "@playwright/test";

// The real in-browser background remover (U²-Netp on ONNX Runtime Web) in
// Chromium at 390 px, through the dev test bench at /dev/cutout (mock mode
// only). Covers: resize + JPEG re-encode, the cut-out's transparency, the
// model cache, the fallback when the model can't load, unreadable (HEIC)
// files, and uploading the result to /api/items/photo.

interface HarnessResult {
  originalBytes: number;
  originalWidth: number;
  originalHeight: number;
  originalType: string;
  cutoutBytes: number | null;
  cutoutWidth: number | null;
  cutoutHeight: number | null;
  cornerAlpha: number | null;
  centreAlpha: number | null;
  cutoutFailure: string | null;
  fileName: string;
  timings: { loadMs: number; inferenceMs: number; totalMs: number } | null;
  uploadStatus: number | null;
  draftHasCutout: boolean | null;
  modelCached: boolean;
}

type RunOptions = { brokenModel?: boolean; upload?: boolean; width?: number; height?: number };

declare global {
  interface Window {
    gladragsCutoutHarness?: { run(options?: RunOptions): Promise<HarnessResult>; prepareUnreadable(): Promise<string> };
  }
}

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page }) => {
  await page.goto("/dev/cutout");
  await expect(page.getByTestId("harness-ready")).toHaveText("ready");
});

test("cuts the item out of a 12 MP photo, uploads both images, and caches the model", async ({ page }) => {
  test.setTimeout(120_000);
  const modelRequests: string[] = [];
  page.on("request", (req) => {
    if (/\/(models|ort)\//.test(req.url())) modelRequests.push(req.url());
  });

  const first = await page.evaluate(() => window.gladragsCutoutHarness!.run({ upload: true }));

  // The photo was shrunk to 1600 px and re-encoded as a JPEG under 1.5 MB.
  expect(first).toMatchObject({ originalType: "image/jpeg", originalWidth: 1200, originalHeight: 1600, fileName: "IMG_4032.HEIC.jpg" });
  expect(first.originalBytes).toBeLessThanOrEqual(1.5 * 1024 * 1024);

  // A real cut-out: transparent corners, opaque item, cropped to the item, under 2.5 MB.
  expect(first.cutoutFailure).toBeNull();
  expect(first.cornerAlpha).toBe(0);
  expect(first.centreAlpha).toBe(255);
  expect(first.cutoutWidth!).toBeLessThan(first.originalWidth);
  expect(first.cutoutBytes!).toBeLessThanOrEqual(2.5 * 1024 * 1024);
  expect(first.uploadStatus).toBe(200);
  expect(first.draftHasCutout).toBe(true);
  expect(first.modelCached).toBe(true);
  console.log(`background removal timings (desktop Chromium): ${JSON.stringify(first.timings)}`);

  // Second photo: the model comes from Cache Storage, not the network.
  modelRequests.length = 0;
  await page.reload();
  await expect(page.getByTestId("harness-ready")).toHaveText("ready");
  const second = await page.evaluate(() => window.gladragsCutoutHarness!.run({ width: 1200, height: 1600 }));
  expect(second.cutoutFailure).toBeNull();
  expect(modelRequests).toEqual([]);
});

test("falls back to the original alone when the model can't be downloaded", async ({ page }) => {
  test.setTimeout(60_000);
  const result = await page.evaluate(() => window.gladragsCutoutHarness!.run({ brokenModel: true, upload: true, width: 800, height: 600 }));
  expect(result).toMatchObject({ cutoutFailure: "model_load_failed", cutoutBytes: null, uploadStatus: 200, draftHasCutout: false });
});

test("a file the browser can't read (HEIC in Chromium) gives a clear 'unreadable' error", async ({ page }) => {
  expect(await page.evaluate(() => window.gladragsCutoutHarness!.prepareUnreadable())).toBe("unreadable");
});
