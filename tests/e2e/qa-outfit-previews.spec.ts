import {
  expect,
  test,
  type Locator,
  type Page,
  type Route,
} from "@playwright/test";
import { installFakeBackgroundRemover } from "./helpers";
import { checkPhoneLayout, expectNoSidewaysScroll } from "./phone-layout";

// QA (round 2, P3): adversarial journeys for outfit pictures at 390 px.
// The preview route is answered here with contract-shaped responses
// (docs/CONTRACTS.md section 12) rather than the shared mock store, whose
// reuse of looks makes markers unreliable. The outfit itself comes from
// the real (mock-mode) GET /api/outfits/:id; only `preview` (and, where a
// test says so, `name`) is replaced. Picture URLs point at /qa-previews/,
// served here: a PNG, or a 404/403 for "missing"/"expired".

type Preview = {
  status: "none" | "pending" | "ready" | "failed" | "skipped";
  imageUrl: string | null;
  failureReason: string | null;
  presetId: string | null;
  suggestedSlots: string[];
  outdated: boolean;
  refreshing: boolean;
};
type Answer =
  | { preview: Preview; name?: string; delayMs?: number }
  | { status: number; error: Record<string, unknown>; delayMs?: number };
type Call = { id: string; refresh: boolean; n: number };

const PRESET = "women_average_medium";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAEElEQVR4nGM40zETiBhQKAB6mguPmsHBPgAAAABJRU5ErkJggg==",
  "base64",
);
const NONE: Preview = {
  status: "none",
  imageUrl: null,
  failureReason: null,
  presetId: null,
  suggestedSlots: [],
  outdated: false,
  refreshing: false,
};
const pending = (): Preview => ({
  ...NONE,
  status: "pending",
  presetId: PRESET,
});
const ready = (url: string, extra: Partial<Preview> = {}): Preview => ({
  ...NONE,
  status: "ready",
  imageUrl: url,
  presetId: PRESET,
  ...extra,
});
const CAP = {
  status: 429,
  error: {
    code: "daily_cap_reached",
    message: "Cap",
    cap: {
      kind: "outfit_previews_per_day",
      limit: 12,
      resetsAt: "2026-11-16T00:00:00.000Z",
    },
  },
};
const PAUSED = {
  status: 503,
  error: {
    code: "ai_paused",
    message: "Paused",
    cap: {
      kind: "monthly_image_spend",
      limit: 200,
      resetsAt: "2026-12-01T00:00:00.000Z",
    },
  },
};
const FAILED = {
  status: 502,
  error: {
    code: "ai_failed",
    message: "We couldn't make a picture of this outfit.",
  },
};

const PREVIEW_ROUTE = /\/api\/outfits\/[^/?]+\/preview(\?.*)?$/;
const OUTFIT_ROUTE = /\/api\/outfits\/[0-9a-f-]{36}(\?.*)?$/;
const LIST_ROUTE = /\/api\/outfits\?/;

/**
 * Plays the preview route. `answer` decides each POST; the last preview
 * given per outfit is also what GET /api/outfits/:id and the saved list say.
 */
async function fakePreviews(
  page: Page,
  answer: (call: Call) => Answer | Promise<Answer>,
) {
  const calls: Call[] = [];
  const shown = new Map<string, Preview>();
  const names = new Map<string, string>();
  const templates = new Map<string, Record<string, unknown>>();
  let inFlight = 0;
  let maxInFlight = 0;

  await page.route("**/qa-previews/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.includes("missing"))
      return route.fulfill({ status: 404, body: "Not found" });
    if (path.includes("expired"))
      return route.fulfill({
        status: 400,
        json: {
          error: "InvalidJWT",
          message: "exp claim timestamp check failed",
        },
      });
    return route.fulfill({ status: 200, contentType: "image/png", body: PNG });
  });

  const patch = (o: Record<string, unknown>) => {
    const id = o.id as string;
    templates.set(id, o);
    return {
      ...o,
      ...(shown.has(id) ? { preview: shown.get(id) } : {}),
      ...(names.has(id) ? { name: names.get(id) } : {}),
    };
  };

  async function outfitFor(
    route: Route,
    id: string,
  ): Promise<Record<string, unknown>> {
    if (templates.has(id)) return templates.get(id)!;
    const url = new URL(route.request().url());
    const res = await route.fetch({
      url: `${url.origin}/api/outfits/${id}`,
      method: "GET",
    });
    const body = (await res.json()) as { outfit: Record<string, unknown> };
    templates.set(id, body.outfit);
    return body.outfit;
  }

  await page.route(PREVIEW_ROUTE, async (route) => {
    const url = new URL(route.request().url());
    const id = url.pathname.split("/")[3]!;
    const call = {
      id,
      refresh: url.searchParams.get("refresh") === "true",
      n: calls.filter((c) => c.id === id).length,
    };
    calls.push(call);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      const a = await answer(call);
      await new Promise((r) => setTimeout(r, a.delayMs ?? 150));
      if ("error" in a) {
        await route.fulfill({ status: a.status, json: { error: a.error } });
        return;
      }
      shown.set(id, a.preview);
      if (a.name) names.set(id, a.name);
      const base = await outfitFor(route, id);
      await route.fulfill({ status: 200, json: { outfit: patch(base) } });
    } catch {
      // The page went away mid-answer.
    } finally {
      inFlight--;
    }
  });

  await page.route(OUTFIT_ROUTE, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    try {
      const res = await route.fetch();
      const body = (await res.json()) as { outfit: Record<string, unknown> };
      await route.fulfill({
        response: res,
        json: { outfit: patch(body.outfit) },
      });
    } catch {
      // Ended mid-request.
    }
  });

  return {
    calls,
    shown,
    templates,
    maxInFlight: () => maxInFlight,
    inFlight: () => inFlight,
  };
}

test.beforeEach(async ({ page }) => {
  await installFakeBackgroundRemover(page);
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "canShare", {
      value: undefined,
      configurable: true,
    });
  });
});

async function tapRadio(page: Page, name: string) {
  const radio = page.getByRole("radio", { name, exact: true });
  await page.locator("label", { has: radio }).click();
}

async function requestOutfits(page: Page, guidance: string) {
  await page.goto("/outfits");
  await tapRadio(page, "Casual");
  await page.getByLabel(/Anything else/).fill(guidance);
  await page.getByRole("button", { name: "Get outfits" }).click();
  await expect(cards(page).first()).toBeVisible();
}

const cards = (page: Page) => page.getByTestId("outfit-card");
const panel = (card: Locator) => card.getByTestId("outfit-preview");
const ids = (page: Page) =>
  cards(page).evaluateAll((els) =>
    els.map((el) => el.getAttribute("data-outfit-id")!),
  );

test.describe("QA: many outfits, refine, navigation", () => {
  test("every outfit is asked for once, strictly one at a time, pending ones polled until ready", async ({
    page,
  }) => {
    const fake = await fakePreviews(page, ({ id, n }) =>
      n === 0
        ? { preview: pending(), delayMs: 400 }
        : { preview: ready(`/qa-previews/${id}.png`), delayMs: 400 },
    );
    await requestOutfits(page, "qa many pictures");
    const shown = await ids(page);
    expect(shown.length).toBeGreaterThan(1);
    for (let i = 0; i < shown.length; i++)
      await expect(panel(cards(page).nth(i))).toHaveAttribute(
        "data-state",
        "ready",
        { timeout: 30_000 },
      );
    expect(fake.maxInFlight()).toBe(1);
    for (const id of shown)
      expect(fake.calls.filter((c) => c.id === id)).toHaveLength(2);
    // In turn: an outfit's poll comes before the next outfit is asked for.
    const order = fake.calls.map((c) => c.id);
    expect(order).toEqual(shown.flatMap((id) => [id, id]));
    await checkPhoneLayout(page, "QA many pictures");
  });

  test("a guidance refinement asks for its new outfits only, and Back asks for nothing", async ({
    page,
  }) => {
    const fake = await fakePreviews(page, ({ id }) => ({
      preview: ready(`/qa-previews/${id}.png`),
    }));
    await requestOutfits(page, "qa refine pictures");
    const first = await ids(page);
    for (let i = 0; i < first.length; i++)
      await expect(panel(cards(page).nth(i))).toHaveAttribute(
        "data-state",
        "ready",
        { timeout: 15_000 },
      );
    const before = fake.calls.length;
    const card = cards(page).first();
    await card.getByRole("button", { name: "Tweak this outfit" }).click();
    await card
      .getByRole("group", { name: "Quick tweaks" })
      .getByRole("button", { name: "Warmer" })
      .click();
    await expect(
      page.getByRole("button", { name: "Back to previous ideas" }),
    ).toBeVisible();
    const second = await ids(page);
    for (let i = 0; i < second.length; i++)
      await expect(panel(cards(page).nth(i))).toHaveAttribute(
        "data-state",
        "ready",
        { timeout: 15_000 },
      );
    const asked = fake.calls.slice(before).map((c) => c.id);
    expect(new Set(asked)).toEqual(
      new Set(second.filter((id) => !first.includes(id))),
    );
    expect(asked.length).toBe(new Set(asked).size);
    const after = fake.calls.length;
    await page.getByRole("button", { name: "Back to previous ideas" }).click();
    await expect(panel(cards(page).first())).toHaveAttribute(
      "data-state",
      "ready",
    );
    await page.waitForTimeout(500);
    expect(fake.calls.length).toBe(after);
    expect(fake.maxInFlight()).toBe(1);
  });

  test("leaving mid-generation stops polling; nothing more is asked for while away", async ({
    page,
  }) => {
    const fake = await fakePreviews(page, () => ({ preview: pending() }));
    await requestOutfits(page, "qa leave mid-generation");
    await expect
      .poll(() => fake.calls.length, { timeout: 10_000 })
      .toBeGreaterThanOrEqual(2);
    await page.getByRole("link", { name: "Wardrobe" }).first().click();
    await expect(page).toHaveURL(/\/wardrobe/);
    await page.waitForTimeout(500);
    const atLeave = fake.calls.length;
    await page.waitForTimeout(7_500);
    expect(fake.calls.length).toBe(atLeave);
  });

  test("a preview pending forever stops at the polling limit and says it's taking a while; the next outfit then goes", async ({
    page,
  }) => {
    await page.clock.install();
    let stuckId: string | null = null;
    const fake = await fakePreviews(page, ({ id }) => {
      stuckId ??= id;
      return id === stuckId
        ? { preview: pending(), delayMs: 0 }
        : { preview: ready(`/qa-previews/${id}.png`), delayMs: 0 };
    });
    await requestOutfits(page, "qa stuck forever");
    const first = cards(page).first();
    await expect(first.getByText("Dressing your model…")).toBeVisible();
    for (let i = 0; i < 80; i++) {
      if ((await panel(first).getAttribute("data-reason")) === "slow") break;
      const before = fake.calls.length;
      await page.clock.runFor(3_100);
      await expect
        .poll(() => fake.calls.length, { timeout: 5_000 })
        .toBeGreaterThan(before)
        .catch(() => {});
    }
    await expect(panel(first)).toHaveAttribute("data-reason", "slow");
    await expect(first.getByTestId("preview-note")).toContainText(
      "This picture is taking a while",
    );
    await expect(first.getByTestId("outfit-collage")).toBeVisible();
    const stuckCalls = fake.calls.filter((c) => c.id === stuckId).length;
    expect(stuckCalls).toBeGreaterThan(10);
    expect(stuckCalls).toBeLessThanOrEqual(61);
    // The rest of the set isn't held up for good.
    await expect(panel(cards(page).nth(1))).toHaveAttribute(
      "data-state",
      "ready",
      { timeout: 10_000 },
    );
  });
});

test.describe("QA: refresh, failures, cap", () => {
  test("Update preview keeps the old picture with Updating… until the new one is ready", async ({
    page,
  }) => {
    const fake = await fakePreviews(page, ({ id, refresh, n }) => {
      if (!refresh)
        return {
          preview: ready(`/qa-previews/${id}-old.png`, { outdated: true }),
        };
      if (n === 1)
        return {
          preview: ready(`/qa-previews/${id}-old.png`, {
            outdated: true,
            refreshing: true,
          }),
        };
      return { preview: ready(`/qa-previews/${id}-new.png`), delayMs: 600 };
    });
    await requestOutfits(page, "qa refresh keeps old");
    const card = cards(page).first();
    const id = (await card.getAttribute("data-outfit-id"))!;
    await expect(panel(card)).toHaveAttribute("data-state", "ready", {
      timeout: 15_000,
    });
    for (let i = 1; i < (await cards(page).count()); i++)
      await expect(panel(cards(page).nth(i))).toHaveAttribute(
        "data-state",
        "ready",
        { timeout: 15_000 },
      );
    await card.getByRole("button", { name: "Update preview" }).click();
    await expect(card.getByTestId("preview-updating")).toBeVisible();
    await expect(card.getByTestId("preview-image")).toHaveAttribute(
      "src",
      `/qa-previews/${id}-old.png`,
    );
    await expect(
      card.getByRole("button", { name: "Update preview" }),
    ).toHaveCount(0);
    await expect(card.getByTestId("preview-image")).toHaveAttribute(
      "src",
      `/qa-previews/${id}-new.png`,
      { timeout: 15_000 },
    );
    await expect(card.getByTestId("preview-updating")).toHaveCount(0);
    expect(fake.calls.filter((c) => c.id === id).map((c) => c.refresh)).toEqual(
      [false, true, true],
    );
    expect(fake.maxInFlight()).toBe(1);
  });

  test("failed, stored-blocked and capped each show their own note, and the cap stops the queue", async ({
    page,
  }) => {
    let order: string[] = [];
    const fake = await fakePreviews(page, ({ id }) => {
      if (!order.includes(id)) order = [...order, id];
      const i = order.indexOf(id);
      if (i === 0) return FAILED;
      if (i === 1)
        return {
          preview: {
            ...NONE,
            status: "failed",
            failureReason: "blocked",
            presetId: PRESET,
          },
        };
      return CAP;
    });
    await page.goto("/outfits");
    await tapRadio(page, "Smart casual");
    await page.getByLabel(/Anything else/).fill("qa three failures");
    await page.getByRole("button", { name: "Get outfits" }).click();
    await expect(cards(page).first()).toBeVisible();
    const n = await cards(page).count();
    test.skip(n < 3, "needs three outfits");
    const shown = await ids(page);
    const card = (i: number) =>
      page.locator(`[data-testid="outfit-card"][data-outfit-id="${shown[i]}"]`);
    await expect(panel(card(0))).toHaveAttribute("data-reason", "failed", {
      timeout: 15_000,
    });
    await expect(panel(card(1))).toHaveAttribute("data-reason", "failed", {
      timeout: 15_000,
    });
    await expect(panel(card(2))).toHaveAttribute("data-reason", "daily_cap", {
      timeout: 15_000,
    });
    await expect(card(0).getByTestId("preview-note")).toContainText(
      "We couldn't picture this one",
    );
    await expect(card(2).getByTestId("preview-note")).toContainText(
      "That's today's outfit pictures used up",
    );
    for (let i = 3; i < n; i++)
      await expect(panel(card(i))).toHaveAttribute("data-reason", "daily_cap");
    expect(fake.calls).toHaveLength(3);
    await checkPhoneLayout(page, "QA mixed picture failures");
  });

  test("a pause stops the queue with its own note", async ({ page }) => {
    const fake = await fakePreviews(page, () => PAUSED);
    await requestOutfits(page, "qa paused queue");
    const n = await cards(page).count();
    for (let i = 0; i < n; i++) {
      await expect(panel(cards(page).nth(i))).toHaveAttribute(
        "data-reason",
        "paused",
        { timeout: 15_000 },
      );
      await expect(
        cards(page).nth(i).getByTestId("preview-note"),
      ).toContainText("Outfit pictures are paused for now");
    }
    expect(fake.calls).toHaveLength(1);
  });
});

test.describe("QA: Pick your model", () => {
  /** No preset saved; the settings PUT answers from `putAnswers` in turn (never touching the shared mock settings). */
  async function withoutPreset(
    page: Page,
    putAnswers: number[],
    getFails = false,
  ) {
    const puts: unknown[] = [];
    await page.route("**/api/settings", async (route) => {
      const request = route.request();
      if (request.method() === "PUT") {
        const body = request.postDataJSON() as { modelPresetId: string };
        puts.push(body);
        const status = putAnswers[puts.length - 1] ?? 200;
        if (status !== 200)
          return route.fulfill({
            status,
            json: { error: { code: "internal", message: "Couldn't save" } },
          });
        return route.fulfill({
          status: 200,
          json: {
            modelPresetId: body.modelPresetId,
            favouriteShopIds: ["next"],
            forwardingAddress: null,
          },
        });
      }
      if (getFails)
        return route.fulfill({
          status: 500,
          json: { error: { code: "internal", message: "Down" } },
        });
      return route.fulfill({
        status: 200,
        json: {
          modelPresetId: null,
          favouriteShopIds: ["next"],
          forwardingAddress: null,
        },
      });
    });
    const saved = () =>
      puts.length > putAnswers.filter((s) => s !== 200).length;
    const fake = await fakePreviews(page, ({ id }) =>
      saved()
        ? { preview: ready(`/qa-previews/${id}.png`) }
        : {
            status: 400,
            error: {
              code: "bad_request",
              message: "Pick a model first.",
              issues: [
                {
                  path: "modelPresetId",
                  message: "No model preset picked yet",
                },
              ],
            },
          },
    );
    return { puts, fake };
  }

  test("a failed save on close keeps the sheet open with an error; trying again saves and the pictures start", async ({
    page,
  }) => {
    const { puts, fake } = await withoutPreset(page, [500]);
    await requestOutfits(page, "qa sheet save fails");
    const sheet = page.getByTestId("pick-model-sheet");
    await expect(
      sheet.getByRole("heading", { name: "Pick your model" }),
    ).toBeVisible();
    await sheet.getByRole("button", { name: "Close" }).click();
    await expect(sheet.getByTestId("api-error")).toBeVisible();
    await expect(sheet).toBeVisible();
    // No picture is asked for while the model isn't saved.
    expect(fake.calls).toHaveLength(0);
    await checkPhoneLayout(page, "QA Pick your model with an error");
    await sheet.getByRole("button", { name: "Use this model" }).click();
    await expect(sheet).toHaveCount(0);
    expect(puts).toEqual([
      { modelPresetId: PRESET },
      { modelPresetId: PRESET },
    ]);
    await expect(panel(cards(page).first())).toHaveAttribute(
      "data-state",
      "ready",
      { timeout: 15_000 },
    );
    expect(fake.maxInFlight()).toBe(1);
  });

  test("when settings can't be read, the route's bad_request on modelPresetId still brings up the sheet", async ({
    page,
  }) => {
    const { fake } = await withoutPreset(page, [], true);
    await requestOutfits(page, "qa settings unreadable");
    const sheet = page.getByTestId("pick-model-sheet");
    await expect(
      sheet.getByRole("heading", { name: "Pick your model" }),
    ).toBeVisible();
    expect(fake.calls).toHaveLength(1);
    await expect(
      cards(page).first().getByText("Pick your model to see this outfit worn."),
    ).toBeAttached();
    await sheet.getByRole("button", { name: "Use this model" }).click();
    await expect(sheet).toHaveCount(0);
    // The refused outfit is asked for again after the pick.
    await expect(panel(cards(page).first())).toHaveAttribute(
      "data-state",
      "ready",
      { timeout: 15_000 },
    );
    expect(fake.calls[1]!.id).toBe(fake.calls[0]!.id);
  });
});

test.describe("QA: picture images", () => {
  for (const kind of ["missing", "expired"] as const) {
    test(`a ${kind} picture URL falls back to the collage; Reload picture fetches a fresh link`, async ({
      page,
    }) => {
      let fresh = false;
      await fakePreviews(page, ({ id }) => ({
        preview: ready(`/qa-previews/${id}-${kind}.png`),
      }));
      await requestOutfits(page, `qa ${kind} picture`);
      const card = cards(page).first();
      const id = (await card.getAttribute("data-outfit-id"))!;
      await expect(card.getByTestId("preview-note")).toContainText(
        "Couldn't load the picture",
        { timeout: 15_000 },
      );
      await expect(card.getByTestId("outfit-collage")).toBeVisible();
      await expect(
        card.getByRole("button", { name: /^Save image of / }),
      ).toBeVisible();
      // The reload signs a new URL.
      await page.route(OUTFIT_ROUTE, async (route) => {
        if (route.request().method() !== "GET") return route.fallback();
        fresh = true;
        const res = await route.fetch();
        const body = (await res.json()) as { outfit: Record<string, unknown> };
        await route.fulfill({
          response: res,
          json: {
            outfit: {
              ...body.outfit,
              preview: ready(`/qa-previews/${id}-fresh.png`),
            },
          },
        });
      });
      await card.getByRole("button", { name: "Reload picture" }).click();
      await expect(card.getByTestId("preview-image")).toHaveAttribute(
        "src",
        `/qa-previews/${id}-fresh.png`,
      );
      await expect(card.getByTestId("preview-image")).toBeVisible();
      expect(fresh).toBe(true);
    });
  }

  test("Save image saves the picture for a long non-ASCII name, without sideways scroll; the collage saves when there's no picture", async ({
    page,
  }) => {
    // The longest name the contract allows (40), with accents, CJK and an em dash.
    const longName = "Été à Paris — 週末のコーデ, layers for a wal".slice(
      0,
      40,
    );
    let first: string | null = null;
    await fakePreviews(page, ({ id }) => {
      first ??= id;
      return id === first
        ? { preview: ready(`/qa-previews/${id}.png`), name: longName }
        : FAILED;
    });
    await requestOutfits(page, "qa save picture names");
    const card = cards(page).first();
    await expect(panel(card)).toHaveAttribute("data-state", "ready", {
      timeout: 15_000,
    });
    await expect(card.getByRole("heading", { level: 2 })).toHaveText(longName);
    await expect(
      card.getByRole("button", { name: /^Save image of / }),
    ).toHaveCount(1);
    const download = page.waitForEvent("download");
    await card
      .getByRole("button", { name: `Save image of ${longName}` })
      .click();
    const file = (await download).suggestedFilename();
    expect(file).toMatch(/^gladrags-[a-z0-9-]+\.png$/);
    expect(file.length).toBeLessThanOrEqual(60);
    await expect(
      card.getByText("Image saved to your downloads."),
    ).toBeVisible();
    await expectNoSidewaysScroll(page);

    const other = cards(page).nth(1);
    await expect(panel(other)).toHaveAttribute("data-reason", "failed", {
      timeout: 15_000,
    });
    await expect(other.getByTestId("outfit-collage")).toHaveAttribute(
      "data-state",
      "ready",
      { timeout: 15_000 },
    );
    const collageDownload = page.waitForEvent("download");
    await other.getByRole("button", { name: /^Save image of / }).click();
    expect((await collageDownload).suggestedFilename()).toMatch(
      /^gladrags-.+\.png$/,
    );
    await checkPhoneLayout(page, "QA long names with pictures");
  });

  test("suggested-slot badges: one per slot, dashed, with names even when the outfit has no matching gap", async ({
    page,
  }) => {
    await fakePreviews(page, ({ id }) => ({
      preview: ready(`/qa-previews/${id}.png`, {
        suggestedSlots: ["shoes", "outerwear", "top"],
      }),
    }));
    await requestOutfits(page, "qa three suggestions");
    const card = cards(page).first();
    await expect(panel(card)).toHaveAttribute("data-state", "ready", {
      timeout: 15_000,
    });
    const items = card
      .getByRole("list", { name: "Suggested pieces, not from your wardrobe" })
      .getByRole("listitem");
    await expect(items).toHaveCount(3);
    for (const text of await items.allTextContents())
      expect(text).toMatch(/^[A-Z][^]* suggested$/);
    await card.getByRole("button", { name: "Show the pieces" }).click();
    await expect(card.getByTestId("outfit-collage")).toBeVisible();
    await expectNoSidewaysScroll(page);
  });
});

test.describe("QA: saved outfits", () => {
  test("pictures are asked for lazily as cards come near, one at a time, and ready ones are never asked for", async ({
    page,
  }) => {
    const fake = await fakePreviews(page, ({ id }) => ({
      preview: ready(`/qa-previews/${id}.png`),
    }));
    // A long saved list: the first real saved outfit, repeated under new ids; every third already pictured.
    const fakeIds: string[] = [];
    await page.route(LIST_ROUTE, async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      const url = new URL(route.request().url());
      const res = await route.fetch();
      const body = (await res.json()) as { outfits: Record<string, unknown>[] };
      if (
        url.searchParams.get("status") !== "saved" ||
        body.outfits.length === 0
      ) {
        return route.fulfill({ response: res, json: { outfits: [] } });
      }
      const base = body.outfits[0]!;
      const outfits = Array.from({ length: 24 }, (_, i) => {
        const id = `7a000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`;
        fakeIds.push(id);
        const o = {
          ...base,
          id,
          name: `QA saved ${i + 1}`,
          status: "saved",
          preview: i % 3 === 0 ? ready(`/qa-previews/${id}-stored.png`) : NONE,
        };
        fake.templates.set(id, o);
        return o;
      });
      await route.fulfill({ response: res, json: { outfits } });
    });

    // Make sure at least one outfit is saved in the shared store.
    await requestOutfits(page, "qa saved lazy");
    // Let the results screen's own pictures finish, so only the saved list's are counted.
    const resultCount = await cards(page).count();
    for (let i = 0; i < resultCount; i++) {
      await expect(panel(cards(page).nth(i))).toHaveAttribute(
        "data-state",
        "ready",
        { timeout: 15_000 },
      );
    }
    const card = cards(page).first();
    const id = (await card.getAttribute("data-outfit-id"))!;
    const save = page.waitForResponse(
      (r) =>
        r.request().method() === "PATCH" &&
        r.url().endsWith(`/api/outfits/${id}`),
    );
    await card
      .getByRole("group", { name: /^Feedback on / })
      .getByRole("button", { name: "Save", exact: true })
      .click();
    await save;
    const beforeSaved = fake.calls.length;

    await page.goto("/outfits/saved");
    await expect(cards(page)).toHaveCount(24);
    await page.waitForTimeout(2_000);
    const early = fake.calls.slice(beforeSaved).map((c) => c.id);
    const needing = fakeIds.filter((_, i) => i % 3 !== 0);
    expect(early.length).toBeGreaterThan(0);
    expect(early.length).toBeLessThan(needing.length);
    for (let i = 0; i < 24; i++) {
      await cards(page).nth(i).scrollIntoViewIfNeeded();
    }
    await expect
      .poll(
        () => new Set(fake.calls.slice(beforeSaved).map((c) => c.id)).size,
        { timeout: 20_000 },
      )
      .toBe(needing.length);
    const asked = fake.calls.slice(beforeSaved).map((c) => c.id);
    expect(new Set(asked)).toEqual(new Set(needing));
    expect(asked.length).toBe(needing.length);
    expect(fake.maxInFlight()).toBe(1);
    await expect(panel(cards(page).last())).toHaveAttribute(
      "data-state",
      "ready",
      { timeout: 10_000 },
    );
    await checkPhoneLayout(page, "QA long saved list with pictures");
  });
});
