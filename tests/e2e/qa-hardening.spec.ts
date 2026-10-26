import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

// QA (fix/hardening), on the 390 px phone viewport against mock mode:
// - the security headers on every kind of response: pages, API answers
//   (including errors), static chunks, the ONNX model and runtime, icons,
//   the service worker and 404s;
// - the Report-Only CSP raises nothing across the five journeys plus
//   add-by-link and its screenshot fallback, with the REAL in-browser
//   background remover (ONNX Runtime + WebAssembly) on the add screens;
// - cross-site requests from a real browser on another origin are refused.

const PHOTO = readFileSync(new URL("./fixtures/shirt.jpg", import.meta.url));

/** Every CSP report from the page, any document it navigates to, and its workers. */
async function collectCsp(page: Page): Promise<string[]> {
  const reports: string[] = [];
  await page.exposeBinding("__qaCspReport", (_source, text: string) => {
    reports.push(text);
  });
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      void (window as unknown as { __qaCspReport: (t: string) => Promise<void> }).__qaCspReport(
        `${event.violatedDirective} blocked ${event.blockedURI} (${event.sourceFile}:${event.lineNumber})`,
      );
    });
  });
  const fromConsole = (text: string) => {
    if (/Content Security Policy|Content-Security-Policy/i.test(text)) reports.push(text);
  };
  page.on("console", (message) => fromConsole(message.text()));
  page.on("worker", (worker) => worker.on("console", (message) => fromConsole(message.text())));
  return reports;
}

function unique(label: string): string {
  return `${label} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function tapRadio(page: Page, name: string) {
  return page.getByRole("radio", { name, exact: true }).locator("xpath=ancestor::label[1]").click();
}

const EXPECTED_HEADERS: Record<string, string | RegExp> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(self), geolocation=(), microphone=()",
  "x-frame-options": "DENY",
  "content-security-policy-report-only": /^default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; /,
};

test.describe("security headers on every kind of response", () => {
  test("static chunks, model files, icons, offline page, 404s and API errors all carry them", async ({ request }) => {
    const html = await (await request.get("/sign-in")).text();
    const chunk = /\/_next\/static\/[^"']+\.js/.exec(html)?.[0];
    const css = /\/_next\/static\/[^"']+\.css/.exec(html)?.[0];
    expect(chunk).toBeTruthy();
    const responses = [
      ["a JS chunk", await request.get(chunk!)],
      ...(css ? [["a CSS file", await request.get(css)] as const] : []),
      ["the ONNX model", await request.get("/models/u2netp.onnx")],
      ["the ONNX runtime wasm", await request.get("/ort/ort-wasm-simd-threaded.wasm")],
      ["an icon", await request.get("/icons/icon-192.png")],
      ["the manifest", await request.get("/manifest.webmanifest")],
      ["the offline page", await request.get("/offline.html")],
      ["a 404 page", await request.get("/qa-no-such-page")],
      ["a 404 API route", await request.get("/api/qa-no-such-route")],
      ["a 403 forbidden", await request.post("/api/outfits", { headers: { origin: "https://evil.example" }, data: {} })],
      ["a 415", await request.post("/api/outfits", { headers: { "content-type": "text/plain" }, data: "{}" })],
      ["a 400", await request.post("/api/outfits", { data: { style: "nope" } })],
      ["the cron route's 500", await request.get("/api/cron/cleanup")],
      ["the /auth/confirm redirect", await request.get("/auth/confirm", { maxRedirects: 0 })],
      ["a PATCH", await request.patch("/api/items/1a000000-0000-4000-8000-0000000000ff", { data: {} })],
    ] as const;
    for (const [label, response] of responses) {
      const headers = response.headers();
      for (const [name, value] of Object.entries(EXPECTED_HEADERS)) {
        if (typeof value === "string") expect(headers[name], `${label}: ${name}`).toBe(value);
        else expect(headers[name], `${label}: ${name}`).toMatch(value);
      }
      expect(headers["x-powered-by"], label).toBeUndefined();
      expect(headers["content-security-policy"], `${label}: CSP is report-only for now`).toBeUndefined();
    }
  });

  test("each header is sent exactly once on a page (no duplicates from the route and next.config)", async ({ request }) => {
    for (const path of ["/wardrobe", "/api/usage", "/auth/confirm?token_hash=abc123&type=email"]) {
      const all = (await request.get(path)).headersArray();
      for (const name of Object.keys(EXPECTED_HEADERS)) {
        expect(all.filter((h) => h.name.toLowerCase() === name).length, `${path}: ${name}`).toBeLessThanOrEqual(1);
      }
    }
  });

  // FINDING (low): src/app/auth/confirm/route.ts sets
  // `Referrer-Policy: no-referrer` on the page that carries the one-time
  // token in its URL, but next.config.ts's site-wide
  // `Referrer-Policy: strict-origin-when-cross-origin` replaces it, so the
  // browser sends the full URL (token_hash included) as the Referer of the
  // form POST. Marked test.fail(): it flips to "passed unexpectedly" once fixed.
  test("FINDING: the /auth/confirm page keeps its token out of the referrer (no-referrer)", async ({ page }) => {
    test.fail(true, "next.config.ts's Referrer-Policy overrides the route's no-referrer");
    const response = await page.goto("/auth/confirm?token_hash=qa-token-abc123&type=email&next=%2Fwardrobe");
    expect(response?.headers()["referrer-policy"]).toBe("no-referrer");
  });

  test("MEASURED: the form POST from /auth/confirm sends the token in its Referer", async ({ page }) => {
    await page.goto("/auth/confirm?token_hash=qa-token-abc123&type=email&next=%2Fwardrobe");
    const posted = page.waitForRequest((r) => r.method() === "POST" && new URL(r.url()).pathname === "/auth/confirm");
    await page.getByRole("button", { name: "Continue signing in" }).click();
    const referer = (await posted).headers()["referer"] ?? "";
    // Documents the leak the FINDING above describes (to our own origin only).
    expect(referer).toContain("token_hash=qa-token-abc123");
  });
});

test.describe("the Report-Only CSP across the journeys, with the real background remover", () => {
  test("control: the collector does see a report (an image from a host the policy doesn't allow)", async ({ page }) => {
    const reports = await collectCsp(page);
    await page.goto("/offline.html");
    await page.evaluate(() => {
      const img = document.createElement("img");
      img.src = "https://evil.example/pixel.png";
      document.body.appendChild(img);
    });
    await expect.poll(() => reports.length).toBeGreaterThan(0);
  });

  test("journey 1 by photo (real ONNX cut-out), item detail, journeys 3, 4 and 5, then sign-in: no reports", async ({ page }) => {
    test.setTimeout(180_000);
    const reports = await collectCsp(page);
    const fetched: string[] = [];
    page.on("request", (r) => fetched.push(new URL(r.url()).pathname));

    // Journey 1: add by photo, with the real remover.
    await page.goto("/add");
    await page.getByTestId("photo-library-input").setInputFiles({ name: "qa-csp.jpg", mimeType: "image/jpeg", buffer: PHOTO });
    await expect(page.getByRole("heading", { name: "Check the tags" })).toBeVisible({ timeout: 90_000 });
    const description = unique("QA CSP shirt");
    await page.getByLabel("Description").fill(description);
    await page.getByRole("button", { name: "Save to wardrobe" }).click();
    await expect(page.getByText("Saved to your wardrobe")).toBeVisible();
    // The real remover ran: it fetched the ONNX model and the WebAssembly runtime.
    expect(fetched.some((p) => p.startsWith("/models/"))).toBe(true);
    expect(fetched.some((p) => p.startsWith("/ort/"))).toBe(true);

    // Wardrobe and item detail, then journey 3 from it.
    await page.goto("/wardrobe");
    await page.getByRole("searchbox", { name: "Search descriptions" }).fill(description);
    await page.getByRole("link", { name: description }).click();
    await expect(page.getByRole("heading", { name: description })).toBeVisible();
    await page.goto("/wardrobe/1a000000-0000-4000-8000-000000000007");
    await page.getByRole("link", { name: "Build an outfit around this" }).click();
    await tapRadio(page, "Casual");
    await page.getByRole("button", { name: "Get outfits" }).click();
    const cards = page.getByTestId("outfit-card");
    await expect(cards.first()).toBeVisible();

    // Journey 4: refine with guidance.
    await cards.first().getByRole("button", { name: "Tweak this outfit" }).click();
    await cards.first().getByRole("button", { name: "Warmer" }).click();
    await expect(page.getByRole("heading", { name: "Tweaked: warmer" })).toBeVisible();

    // Journey 5: save one, then the saved screen.
    await cards.first().getByRole("button", { name: "Save", exact: true }).click();
    await expect(cards.first().getByRole("button", { name: "Saved", exact: true })).toBeVisible();
    await page.goto("/outfits/saved");
    await expect(page.getByRole("heading", { name: "Saved outfits" })).toBeVisible();
    await page.waitForLoadState("networkidle");

    await page.goto("/sign-in");
    await page.waitForLoadState("networkidle");
    expect(reports).toEqual([]);
  });

  test("add by link (real ONNX cut-out of the product image) and the screenshot fallback: no reports", async ({ page }) => {
    test.setTimeout(180_000);
    const reports = await collectCsp(page);

    await page.goto("/add/link");
    await page.getByLabel("Product link").fill(`https://shop.example.com/products/qa-${Date.now()}`);
    await page.getByRole("button", { name: "Add from link" }).click();
    await expect(page.getByRole("heading", { name: "Check the tags" })).toBeVisible({ timeout: 90_000 });
    await page.getByLabel("Description").fill(unique("QA CSP link"));
    await page.getByRole("button", { name: "Save to wardrobe" }).click();
    await expect(page.getByText("Saved to your wardrobe")).toBeVisible();

    await page.goto("/add/link");
    await page.getByLabel("Product link").fill(`https://blocked.example.com/p/${Date.now()}`);
    await page.getByRole("button", { name: "Add from link" }).click();
    await expect(page.getByRole("heading", { name: "Add a screenshot" })).toBeVisible();
    await page.getByTestId("photo-library-input").setInputFiles({ name: "screenshot.jpg", mimeType: "image/jpeg", buffer: PHOTO });
    await expect(page.getByRole("heading", { name: "Check the tags" })).toBeVisible({ timeout: 90_000 });
    await page.waitForLoadState("networkidle");
    expect(reports).toEqual([]);
  });
});

test.describe("cross-site requests from a real browser on another origin", () => {
  // localhost and 127.0.0.1 are different sites to the browser, so a page
  // served from 127.0.0.1 posting to localhost is a genuine cross-site request.
  function otherOrigin(baseURL: string): string {
    const url = new URL(baseURL);
    url.hostname = url.hostname === "localhost" ? "127.0.0.1" : "localhost";
    return url.origin;
  }

  test("an auto-submitting form on another site can't sign the user out or post to the API", async ({ context, baseURL }) => {
    const target = baseURL!;
    const evil = otherOrigin(target);
    for (const [action, enctype] of [
      ["/api/auth/sign-out", "application/x-www-form-urlencoded"],
      ["/api/items/photo", "multipart/form-data"],
      ["/api/outfits", "text/plain"],
    ] as const) {
      const page = await context.newPage();
      await page.goto(`${evil}/offline.html`);
      const response = page.waitForResponse((r) => new URL(r.url()).pathname === action);
      await page.evaluate(
        ({ url, enctype }) => {
          const form = document.createElement("form");
          form.method = "POST";
          form.action = url;
          form.enctype = enctype;
          const input = document.createElement("input");
          input.name = '{"style":{"kind":"preset","presetId":"work"},"x":"';
          input.value = '"}';
          form.appendChild(input);
          document.body.appendChild(form);
          form.submit();
        },
        { url: `${target}${action}`, enctype },
      );
      const answered = await response;
      expect(answered.status(), action).toBe(403);
      expect(answered.request().headers()["origin"], action).toBe(evil);
      await page.close();
    }
  });

  test("a cross-site fetch (no-cors, text/plain) to a JSON route is refused before it runs", async ({ page, baseURL }) => {
    const target = baseURL!;
    await page.goto(`${otherOrigin(target)}/offline.html`);
    const response = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/outfits");
    await page.evaluate(async (url) => {
      await fetch(url, {
        method: "POST",
        mode: "no-cors",
        credentials: "include",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify({ style: { kind: "preset", presetId: "work" }, count: 3 }),
      });
    }, `${target}/api/outfits`);
    expect((await response).status()).toBe(403);
  });

  test("the /auth/confirm form posted from another site is refused and doesn't sign in", async ({ page, baseURL }) => {
    const target = baseURL!;
    await page.goto(`${otherOrigin(target)}/offline.html`);
    const response = page.waitForResponse((r) => new URL(r.url()).pathname === "/auth/confirm" && r.request().method() === "POST");
    await page.evaluate((url) => {
      const form = document.createElement("form");
      form.method = "POST";
      form.action = url;
      for (const [name, value] of [["token_hash", "attacker-token"], ["type", "email"], ["next", "/wardrobe"]]) {
        const input = document.createElement("input");
        input.name = name!;
        input.value = value!;
        form.appendChild(input);
      }
      document.body.appendChild(form);
      form.submit();
    }, `${target}/auth/confirm`);
    const answered = await response;
    expect(answered.status()).toBe(403);
    expect(answered.headers()["location"]).toBeUndefined();
  });

  test("the same forms from this site's own origin are accepted", async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/offline.html`);
    const response = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/auth/sign-out");
    await page.evaluate(() => {
      const form = document.createElement("form");
      form.method = "POST";
      form.action = "/api/auth/sign-out";
      document.body.appendChild(form);
      form.submit();
    });
    expect((await response).status()).toBe(303);
  });
});
