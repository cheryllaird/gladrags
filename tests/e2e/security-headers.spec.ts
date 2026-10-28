import { expect, test, type Page } from "@playwright/test";

// Security headers (next.config.ts) and the request checks around them:
// - every response carries the headers, and none advertises Next.js;
// - our own pages don't break the Report-Only Content Security Policy,
//   including the real background remover (ONNX Runtime, WebAssembly and
//   workers), the service worker and the outfit collages;
// - cross-site API calls, non-JSON bodies and the unprotected cron route
//   are refused.

interface Violation {
  directive: string;
  blocked: string;
  source: string;
}

declare global {
  interface Window {
    __cspViolations?: Violation[];
  }
}

/** Collect every CSP violation the page (or one of its workers) reports. */
async function watchCsp(page: Page): Promise<() => Promise<string[]>> {
  const consoleReports: string[] = [];
  page.on("console", (message) => {
    if (/Content Security Policy|Content-Security-Policy/i.test(message.text())) consoleReports.push(message.text());
  });
  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      window.__cspViolations!.push({ directive: event.violatedDirective, blocked: event.blockedURI, source: event.sourceFile });
    });
  });
  return async () => {
    const fromDocument = await page.evaluate(() => window.__cspViolations ?? []).catch(() => [] as Violation[]);
    return [...fromDocument.map((v) => `${v.directive} blocked ${v.blocked} (${v.source})`), ...consoleReports];
  };
}

test("every page and API response carries the security headers", async ({ request }) => {
  for (const path of ["/", "/wardrobe", "/sign-in", "/api/usage", "/sw.js", "/manifest.webmanifest"]) {
    const response = await request.get(path, { maxRedirects: 0 });
    const headers = response.headers();
    expect(headers["x-content-type-options"], path).toBe("nosniff");
    expect(headers["referrer-policy"], path).toBe("strict-origin-when-cross-origin");
    expect(headers["permissions-policy"], path).toBe("camera=(self), geolocation=(), microphone=()");
    expect(headers["x-frame-options"], path).toBe("DENY");
    expect(headers["x-powered-by"], path).toBeUndefined();
    const csp = headers["content-security-policy-report-only"];
    expect(csp, path).toContain("default-src 'self'");
    expect(csp, path).toContain("script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'");
    expect(csp, path).toContain("img-src 'self' blob: data: https://*.supabase.co");
    expect(csp, path).toContain("connect-src 'self' https://*.supabase.co");
    expect(csp, path).toContain("worker-src 'self' blob:");
    expect(csp, path).toContain("object-src 'none'");
    expect(csp, path).toContain("frame-ancestors 'none'");
    expect(csp, path).toContain("report-uri /api/csp-report");
    expect(csp, path).toContain("report-to csp-endpoint");
    expect(headers["reporting-endpoints"], path).toBe('csp-endpoint="/api/csp-report"');
    // Report-Only for now: nothing is enforced yet.
    expect(headers["content-security-policy"], path).toBeUndefined();
  }
});

test("the main screens raise no CSP reports", async ({ page }) => {
  const violations = await watchCsp(page);
  for (const path of ["/wardrobe", "/add", "/add/link", "/outfits", "/outfits/saved", "/sign-in"]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
  }
  // An item's detail screen, with its image.
  await page.goto("/wardrobe");
  await page.getByRole("link").filter({ has: page.locator("img") }).first().click();
  await page.waitForLoadState("networkidle");
  expect(await violations()).toEqual([]);
});

test("outfit results and their canvas collages raise no CSP reports", async ({ page }) => {
  const violations = await watchCsp(page);
  await page.goto("/outfits");
  const radio = page.getByRole("radio", { name: "Smart casual", exact: true });
  await radio.locator("xpath=ancestor::label[1]").click();
  await page.getByRole("button", { name: "Get outfits" }).click();
  await expect(page.getByTestId("outfit-card")).toHaveCount(4);
  await page.waitForLoadState("networkidle");
  expect(await violations()).toEqual([]);
});

test("the real background remover (ONNX Runtime, WebAssembly) and the service worker raise no CSP reports", async ({ page }) => {
  test.setTimeout(120_000);
  const violations = await watchCsp(page);
  await page.goto("/dev/cutout");
  await expect(page.getByTestId("harness-ready")).toHaveText("ready");
  const result = await page.evaluate(() =>
    (window as unknown as { gladragsCutoutHarness: { run(o: object): Promise<{ cutoutFailure: string | null; cornerAlpha: number | null }> } })
      .gladragsCutoutHarness.run({ upload: true }),
  );
  expect(result.cutoutFailure).toBeNull();
  expect(result.cornerAlpha).toBe(0);
  // The service worker registers on the app's pages.
  await page.goto("/wardrobe");
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    return registration.active?.scriptURL ?? null;
  });
  expect(await violations()).toEqual([]);
});

test("the /auth/confirm landing page posts back to itself and raises no CSP reports", async ({ page }) => {
  const violations = await watchCsp(page);
  const response = await page.goto("/auth/confirm?token_hash=abc123&type=email&next=%2Fwardrobe");
  expect(response?.status()).toBe(200);
  expect(response?.headers()["cache-control"]).toBe("no-store");
  await expect(page.getByRole("button", { name: "Continue signing in" })).toBeVisible();
  expect(await page.locator("form").getAttribute("method")).toBe("post");
  expect(await violations()).toEqual([]);
});

test("a cross-site API call is refused with 403 before it does anything", async ({ request, baseURL }) => {
  const evil = await request.post("/api/outfits", {
    headers: { origin: "https://evil.example" },
    data: { style: { kind: "preset", presetId: "work" }, count: 3 },
  });
  expect(evil.status()).toBe(403);
  expect((await evil.json()).error.code).toBe("forbidden");

  const same = await request.post("/api/outfits", {
    headers: { origin: baseURL! },
    data: { style: { kind: "preset", presetId: "work" }, count: 3 },
  });
  expect(same.status()).toBe(200);
});

test("a JSON route refuses a body that isn't labelled JSON (what a form on another site would send)", async ({ request }) => {
  const response = await request.post("/api/outfits", {
    headers: { "content-type": "text/plain" },
    data: JSON.stringify({ style: { kind: "preset", presetId: "work" }, count: 3 }),
  });
  expect(response.status()).toBe(415);
  expect((await response.json()).error.code).toBe("unsupported_media_type");
});

// Chrome delivers report-to reports out of band, batched and delayed, so a
// page can't observe them; this posts the shapes browsers send.
test("/api/csp-report takes both report formats (204) without sign-in or CSRF headers", async ({ request }) => {
  const legacy = await request.post("/api/csp-report", {
    headers: { "content-type": "application/csp-report" },
    data: JSON.stringify({ "csp-report": { "effective-directive": "img-src", "blocked-uri": "https://evil.example/pixel.png" } }),
  });
  expect(legacy.status()).toBe(204);
  const batch = await request.post("/api/csp-report", {
    headers: { "content-type": "application/reports+json", origin: "null" },
    data: JSON.stringify([{ type: "csp-violation", body: { effectiveDirective: "img-src", blockedURL: "https://evil.example/p.png" } }]),
  });
  expect(batch.status()).toBe(204);
  const huge = await request.post("/api/csp-report", { headers: { "content-type": "application/csp-report" }, data: "x".repeat(20_000) });
  expect(huge.status()).toBe(413);
});

test("the cleanup job isn't sent to sign-in and refuses without a secret", async ({ request }) => {
  const response = await request.get("/api/cron/cleanup", { maxRedirects: 0 });
  // This test server has no CRON_SECRET: the job can't run at all.
  expect(response.status()).toBe(500);
  expect((await response.json()).error.code).toBe("server_misconfigured");
});
