import { expect, test, type Locator, type Page } from "@playwright/test";
import { OutfitGenerationResponseSchema, OutfitResponseSchema, type Outfit } from "@/contracts";
import { installFakeBackgroundRemover } from "./helpers";
import { checkPhoneLayout } from "./phone-layout";

// Journeys 2 and 5 (SPEC.md) with outfit pictures on (round 2), on a
// 390 px phone in mock mode: the generated picture replaces the collage,
// which shows while it's made. journeys.spec.ts and journeys-m5.spec.ts
// keep previews off (collagesOnlyForFile) to check the collages
// themselves; this file checks the same journeys as people now see them.
// The mock store is shared, so each test picks out its own outfits by ID.

test.beforeEach(async ({ page }) => {
  await installFakeBackgroundRemover(page);
});

async function tapRadio(page: Page, name: string) {
  const radio = page.getByRole("radio", { name, exact: true });
  await page.locator("label", { has: radio }).click();
  await expect(radio).toBeChecked();
}

async function getOutfits(page: Page, style: string, guidance: string): Promise<Outfit[]> {
  await page.goto("/outfits");
  await tapRadio(page, style);
  await page.getByLabel(/Anything else/).fill(guidance);
  const response = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/outfits");
  await page.getByRole("button", { name: "Get outfits" }).click();
  const body = OutfitGenerationResponseSchema.parse(await (await response).json());
  if (body.status !== "ok") throw new Error(`Expected outfits, got ${body.status}`);
  return body.outfits;
}

const card = (page: Page, id: string) => page.locator(`[data-testid="outfit-card"][data-outfit-id="${id}"]`);
const panel = (c: Locator) => c.getByTestId("outfit-preview");

async function expectPictured(c: Locator) {
  await expect(panel(c)).toHaveAttribute("data-state", "ready", { timeout: 15_000 });
  await expect(c.getByTestId("preview-image")).toBeVisible();
}

test.describe("journey 2 with pictures: outfits for an occasion", () => {
  test("each outfit has a name, a reason and a picture of the model wearing it, made in turn", async ({ page }) => {
    const outfits = await getOutfits(page, "Work", "journey 2 pictured");
    expect(outfits.length).toBeGreaterThanOrEqual(3);
    // The collage is the placeholder while the first picture is made.
    await expect(card(page, outfits[0]!.id).getByText("Dressing your model…")).toBeVisible();
    for (const outfit of outfits) {
      const c = card(page, outfit.id);
      await expect(c.getByRole("heading", { level: 2, name: outfit.name })).toBeVisible();
      await expect(c.getByText(outfit.reason)).toBeVisible();
      await expectPictured(c);
      await expect(c.getByRole("list", { name: "Items in this outfit" })).toBeVisible();
    }
    await checkPhoneLayout(page, "journey 2 results with pictures");
  });

  test("from a sparse wardrobe: the missing piece is suggested, drawn on the model and labelled", async ({ page }) => {
    const outfits = await getOutfits(page, "Casual", "mock-gaps journey 2");
    await expect(page.getByTestId("missing-categories")).toContainText(/shoes/i);
    const c = card(page, outfits[0]!.id);
    await expectPictured(c);
    await expect(c.getByRole("list", { name: "Suggested pieces, not from your wardrobe" })).toHaveText(/suggested$/);
  });

  test("when pictures can't be made, the journey still works with collages", async ({ page }) => {
    const outfits = await getOutfits(page, "Work", "mock-preview-fails journey 2");
    const c = card(page, outfits[0]!.id);
    await expect(panel(c)).toHaveAttribute("data-reason", "failed", { timeout: 15_000 });
    await expect(c.getByTestId("outfit-collage")).toHaveAttribute("data-state", "ready");
  });
});

test.describe("journey 5 with pictures: save and rate", () => {
  test("save one, like one, reject one; the Saved screen shows their pictures without asking again", async ({ page, request }) => {
    const outfits = await getOutfits(page, "Evening out", "journey 5 pictured");
    const [saved, liked, rejected] = outfits;
    for (const o of [saved!, liked!, rejected!]) await expectPictured(card(page, o.id));

    try {
      await card(page, saved!.id).getByRole("button", { name: "Save", exact: true }).click();
      await expect(card(page, saved!.id).getByRole("button", { name: "Saved", exact: true })).toHaveAttribute("aria-pressed", "true");
      await card(page, liked!.id).getByRole("button", { name: "Like", exact: true }).click();
      await expect(card(page, liked!.id).getByRole("button", { name: "Liked", exact: true })).toHaveAttribute("aria-pressed", "true");
      await card(page, rejected!.id).getByRole("button", { name: "Reject", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Not for you?" });
      await dialog.getByRole("button", { name: "Reject outfit" }).click();
      await expect(card(page, rejected!.id)).toHaveAttribute("data-status", "rejected");

      const previewPosts: string[] = [];
      page.on("request", (r) => {
        if (r.method() === "POST" && /\/preview$/.test(new URL(r.url()).pathname)) previewPosts.push(r.url());
      });
      await page.goto("/outfits/saved");
      for (const o of [saved!, liked!]) {
        const c = card(page, o.id);
        await c.scrollIntoViewIfNeeded();
        await expectPictured(c);
        await expect(c.getByRole("button", { name: "See it worn" })).toHaveCount(0);
      }
      await expect(card(page, rejected!.id)).toHaveCount(0);
      // Their pictures were stored: the saved list asks for nothing.
      expect(previewPosts).toEqual([]);

      // Saved outfits keep their picture on the server too.
      const res = await request.get(`/api/outfits/${saved!.id}`);
      expect(OutfitResponseSchema.parse(await res.json()).outfit.preview.status).toBe("ready");
      await checkPhoneLayout(page, "journey 5 saved with pictures");
    } finally {
      for (const o of [saved!, liked!, rejected!]) {
        await request.patch(`/api/outfits/${o.id}`, { data: { status: "suggested" } });
      }
    }
  });
});
