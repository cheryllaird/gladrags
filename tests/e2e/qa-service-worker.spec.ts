import { expect, test } from "@playwright/test";

// QA: the real service worker in Chromium at 390 px. Installing or updating
// it must keep the background-removal model's Cache Storage, and once it
// controls the page it must never cache API responses or images (they're
// private and served through short-lived signed URLs).
//
// The app only registers the worker in production builds, so this test
// registers /sw.js itself; that works against `pnpm dev` and `pnpm start`.

const MODEL_CACHE = "gladrags-models-v1";
const MODEL_URL = "/models/u2netp.onnx?v=qa";

test("an install/update keeps the model cache, drops old shell caches, and never caches API or image responses", async ({ page }) => {
  await page.goto("/offline.html");

  // Before the worker: a cached model (as after a first cut-out) and an old shell cache.
  await page.evaluate(
    async ({ modelCache, modelUrl }) => {
      await (await caches.open(modelCache)).put(modelUrl, new Response("fake model bytes"));
      await (await caches.open("gladrags-shell-v0")).put("/old.html", new Response("old"));
    },
    { modelCache: MODEL_CACHE, modelUrl: MODEL_URL },
  );

  await page.evaluate(async () => {
    await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    await navigator.serviceWorker.ready;
  });
  // Activation runs asynchronously after `ready`; wait for the old shell cache to go.
  await expect.poll(() => page.evaluate(() => caches.keys())).not.toContain("gladrags-shell-v0");

  const after = await page.evaluate(
    async ({ modelCache, modelUrl }) => ({
      keys: await caches.keys(),
      model: await (await (await caches.open(modelCache)).match(modelUrl))?.text(),
    }),
    { modelCache: MODEL_CACHE, modelUrl: MODEL_URL },
  );
  expect(after.keys).toContain(MODEL_CACHE);
  expect(after.keys).toContain("gladrags-shell-v1");
  expect(after.model).toBe("fake model bytes");

  // Now let the worker control the page, then fetch private things through it.
  await page.reload();
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
  const statuses = await page.evaluate(async () => {
    const urls = ["/api/items", "/api/usage", "/mock/items/qa-not-there.png", "/icons/icon-192.png"];
    return Promise.all(urls.map(async (u) => (await fetch(u)).status));
  });
  expect(statuses[0]).toBe(200);

  const cached = await page.evaluate(async () => {
    const all: string[] = [];
    for (const name of await caches.keys()) {
      for (const req of await (await caches.open(name)).keys()) all.push(new URL(req.url).pathname);
    }
    return all;
  });
  expect(cached.filter((p) => p.startsWith("/api/"))).toEqual([]);
  expect(cached.filter((p) => p.startsWith("/mock/"))).toEqual([]);
  // Only the shell (offline page + icon) and the model are cached.
  // (Hashed /_next/static build assets may also be cached; they're public.)
  expect(cached.filter((p) => !p.startsWith("/_next/static/")).sort()).toEqual(
    ["/icons/icon-192.png", "/models/u2netp.onnx", "/offline.html"].sort(),
  );

  await page.evaluate(async () => {
    for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
  });
});
