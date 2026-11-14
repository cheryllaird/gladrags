import { expect, test, type Page } from "@playwright/test";
import { checkPhoneLayout } from "./phone-layout";

// Round 2, task P4: "Your model" in settings, at 390 px in mock mode.
//
// The mock store is shared by every test running in parallel, and the
// preset decides which picture outfit previews show, so these tests don't
// change the real mock user's preset: each answers /api/settings itself
// from its own copy (the request bodies are checked). The last test talks
// to the real mock route, saving the preset it already has.

const DEFAULT_PRESET = "women_average_medium";

interface FakeSettings {
  modelPresetId: string | null;
  favouriteShopIds: string[];
  forwardingAddress: string | null;
}

/** Answers GET and PUT /api/settings from a local copy; `failNextPut` answers the next PUT with a 500. */
async function fakeSettings(page: Page, initial: Partial<FakeSettings> = {}) {
  const state = {
    settings: { modelPresetId: DEFAULT_PRESET, favouriteShopIds: ["next"], forwardingAddress: null, ...initial } as FakeSettings,
    puts: [] as unknown[],
    failNextPut: false,
  };
  await page.route("**/api/settings", async (route) => {
    const request = route.request();
    if (request.method() === "PUT") {
      const body = request.postDataJSON() as Partial<FakeSettings>;
      state.puts.push(body);
      if (state.failNextPut) {
        state.failNextPut = false;
        await route.fulfill({ status: 500, json: { error: { code: "internal", message: "Something went wrong" } } });
        return;
      }
      state.settings = { ...state.settings, ...body };
    }
    await route.fulfill({ json: state.settings });
  });
  return state;
}

const presetGrid = (page: Page) => page.getByTestId("model-preset-grid");
const currentModel = (page: Page) => page.getByTestId("current-model");

/**
 * Taps an option as a finger would: on its label (the picture and caption).
 * The radio inside is visually hidden, so a click aimed at it would land on
 * the picture.
 */
async function tap(page: Page, name: string) {
  await page.locator("label", { has: page.getByRole("radio", { name, exact: true }) }).click();
}

test.describe("settings: your model", () => {
  test("shows the saved model, changes it to a men's figure, and saves", async ({ page }) => {
    const fake = await fakeSettings(page);
    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: "Your model" })).toBeVisible();
    await expect(currentModel(page)).toContainText("Women's, average build, medium skin tone");
    await expect(page.getByText("Previews of new outfits use this model. Existing previews stay as they are.")).toBeVisible();
    await checkPhoneLayout(page, "settings with a model");

    await page.getByRole("button", { name: "Change model" }).click();
    await expect(page.getByRole("radio", { name: "Women's figures", exact: true })).toBeChecked();
    await expect(presetGrid(page).getByRole("radio")).toHaveCount(12);
    await expect(page.getByRole("radio", { name: "Women's, average build, medium skin tone", exact: true })).toBeChecked();
    await expect(page.getByRole("button", { name: "Save model" })).toBeDisabled();
    await checkPhoneLayout(page, "the model picker");

    // The preset pictures load from public/presets.
    const loaded = await presetGrid(page)
      .locator("img")
      .evaluateAll((imgs) => Promise.all(imgs.map((img) => (img as HTMLImageElement).decode().then(() => (img as HTMLImageElement).naturalWidth > 0, () => false))));
    expect(loaded).toEqual(Array(12).fill(true));

    await tap(page, "Men's figures");
    await expect(presetGrid(page).getByRole("radio", { name: /^Men's, / })).toHaveCount(12);
    await expect(page.getByText("Broad build")).toBeVisible();
    await tap(page, "Men's, broad build, deep skin tone");
    await expect(page.getByText("Selected: Men's, broad build, deep skin tone")).toBeVisible();
    await page.getByRole("button", { name: "Save model" }).click();

    await expect(page.getByText("Model saved.")).toBeVisible();
    await expect(currentModel(page)).toContainText("Men's, broad build, deep skin tone");
    await expect(page.getByTestId("model-picker")).toHaveCount(0);
    expect(fake.puts).toEqual([{ modelPresetId: "men_broad_deep" }]);

    // It stays after a reload.
    await page.reload();
    await expect(currentModel(page)).toContainText("Men's, broad build, deep skin tone");
    await page.getByRole("button", { name: "Change model" }).click();
    await expect(page.getByRole("radio", { name: "Men's figures", exact: true })).toBeChecked();
    await expect(page.getByRole("radio", { name: "Men's, broad build, deep skin tone", exact: true })).toBeChecked();
  });

  test("not picked yet: opens on the default, which can be saved as it is", async ({ page }) => {
    const fake = await fakeSettings(page, { modelPresetId: null });
    await page.goto("/settings");
    await expect(currentModel(page)).toContainText("Not picked yet");
    await page.getByRole("button", { name: "Choose a model" }).click();
    await expect(page.getByRole("radio", { name: "Women's, average build, medium skin tone", exact: true })).toBeChecked();
    await page.getByRole("button", { name: "Save model" }).click();
    await expect(currentModel(page)).toContainText("Women's, average build, medium skin tone");
    expect(fake.puts).toEqual([{ modelPresetId: DEFAULT_PRESET }]);
  });

  test("a failed save keeps the old model and the user's choice, to try again", async ({ page }) => {
    const fake = await fakeSettings(page);
    fake.failNextPut = true;
    await page.goto("/settings");
    await page.getByRole("button", { name: "Change model" }).click();
    await tap(page, "Women's, plus size build, light skin tone");
    await page.getByRole("button", { name: "Save model" }).click();

    await expect(page.getByTestId("model-picker").getByRole("alert")).toContainText("Something went wrong");
    await expect(currentModel(page)).toContainText("Women's, average build, medium skin tone");
    await expect(page.getByRole("radio", { name: "Women's, plus size build, light skin tone", exact: true })).toBeChecked();
    await checkPhoneLayout(page, "the model picker after a failed save");

    await page.getByRole("button", { name: "Save model" }).click();
    await expect(page.getByText("Model saved.")).toBeVisible();
    await expect(currentModel(page)).toContainText("Women's, plus size build, light skin tone");
    expect(fake.puts).toHaveLength(2);
  });

  test("keyboard: arrow keys move through the presets, as a radio group", async ({ page }) => {
    await fakeSettings(page);
    await page.goto("/settings");
    await page.getByRole("button", { name: "Change model" }).click();
    await page.getByRole("radio", { name: "Women's, average build, medium skin tone", exact: true }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("radio", { name: "Women's, average build, deep skin tone", exact: true })).toBeChecked();
    await expect(page.getByRole("radio", { name: "Women's, average build, deep skin tone", exact: true })).toBeFocused();
  });

  test("the real mock route accepts a preset on its own", async ({ page }) => {
    const before = await (await page.request.get("/api/settings")).json();
    // Saving the preset it already has, so tests running alongside see no change.
    const presetId = before.modelPresetId ?? DEFAULT_PRESET;
    const response = await page.request.put("/api/settings", { data: { modelPresetId: presetId } });
    expect(response.status()).toBe(200);
    const after = await response.json();
    expect(after.modelPresetId).toBe(presetId);
    expect(after.favouriteShopIds).toEqual(before.favouriteShopIds);

    const refused = await page.request.put("/api/settings", { data: { modelPresetId: "women_tall_light" } });
    expect(refused.status()).toBe(400);
    const cleared = await page.request.put("/api/settings", { data: { modelPresetId: null } });
    expect(cleared.status()).toBe(400);
  });
});
