import { expect, test, type Page, type Route } from "@playwright/test";
import { MODEL_PRESETS } from "@/contracts";
import { checkPhoneLayout, expectNoSidewaysScroll } from "./phone-layout";

// QA for round 2, task P4: adversarial checks of "Your model" in settings
// and the shared <ModelPresetGrid>, at 390 px in mock mode.
//
// Like settings-model-picker.spec.ts, every test answers /api/settings
// itself from its own copy, so the shared mock user's preset (which other
// tests' outfit previews depend on) never changes.

const DEFAULT_PRESET = "women_average_medium";
const DEFAULT_LABEL = "Women's, average build, medium skin tone";

interface FakeSettings {
  modelPresetId: string | null;
  favouriteShopIds: string[];
  forwardingAddress: string | null;
}

interface FakeOptions {
  /** Called for each PUT before it's answered; may delay or replace the answer. */
  onPut?: (route: Route, body: Partial<FakeSettings>) => Promise<"handled" | void>;
}

async function fakeSettings(page: Page, initial: Partial<FakeSettings> = {}, options: FakeOptions = {}) {
  const state = {
    settings: { modelPresetId: DEFAULT_PRESET, favouriteShopIds: ["next"], forwardingAddress: null, ...initial } as FakeSettings,
    puts: [] as Partial<FakeSettings>[],
  };
  await page.route("**/api/settings", async (route) => {
    const request = route.request();
    if (request.method() === "PUT") {
      const body = request.postDataJSON() as Partial<FakeSettings>;
      state.puts.push(body);
      if ((await options.onPut?.(route, body)) === "handled") return;
      state.settings = { ...state.settings, ...body };
    }
    await route.fulfill({ json: state.settings });
  });
  return state;
}

const presetGrid = (page: Page) => page.getByTestId("model-preset-grid");
const picker = (page: Page) => page.getByTestId("model-picker");
const currentModel = (page: Page) => page.getByTestId("current-model");
const radio = (page: Page, name: string) => page.getByRole("radio", { name, exact: true });
const saveButton = (page: Page) => picker(page).getByRole("button", { name: /^(Save model|Saving…)$/ });

async function tap(page: Page, name: string) {
  await page.locator("label", { has: radio(page, name) }).click();
}

async function openPicker(page: Page, buttonName = "Change model") {
  await page.goto("/settings");
  await page.getByRole("button", { name: buttonName }).click();
  await expect(picker(page)).toBeVisible();
}

test.describe("QA settings model picker: every preset", () => {
  test("all 24 presets are listed under their figure, named by their contract label, and selectable", async ({ page }) => {
    await fakeSettings(page);
    await openPicker(page);

    for (const gender of ["women", "men"] as const) {
      await tap(page, gender === "women" ? "Women's figures" : "Men's figures");
      const expected = MODEL_PRESETS.filter((p) => p.gender === gender);
      // Exactly this figure's presets, in grid order, each named by its full label.
      const names = await presetGrid(page)
        .getByRole("radio")
        .evaluateAll((els) => els.map((el) => el.getAttribute("aria-label")));
      expect(names).toEqual(expected.map((p) => p.label));

      for (const preset of expected) {
        await tap(page, preset.label);
        await expect(radio(page, preset.label)).toBeChecked();
        await expect(presetGrid(page).getByRole("radio", { checked: true })).toHaveCount(1);
        await expect(picker(page).getByText(`Selected: ${preset.label}`)).toBeVisible();
        // The image shows the preset's own picture.
        await expect(page.locator("label", { has: radio(page, preset.label) }).locator("img")).toHaveAttribute("src", preset.imagePath);
      }
    }
  });

  test("the radio groups have names a screen reader can announce", async ({ page }) => {
    await fakeSettings(page);
    await openPicker(page);
    await expect(page.getByRole("group", { name: "Figure", exact: true })).toBeVisible();
    await expect(page.getByRole("group", { name: "Your model: Women's figures" })).toBeVisible();
    await tap(page, "Men's figures");
    await expect(page.getByRole("group", { name: "Your model: Men's figures" })).toBeVisible();
    // Captions and headings are hidden from the accessibility tree, so each option is announced once, by its label.
    await expect(presetGrid(page).getByRole("radio", { name: /skin tone$/ })).toHaveCount(12);
  });

  test("the saved preset of each figure opens on that figure, with it checked", async ({ page }) => {
    for (const preset of [MODEL_PRESETS[0]!, MODEL_PRESETS[MODEL_PRESETS.length - 1]!]) {
      await page.unrouteAll({ behavior: "wait" });
      await fakeSettings(page, { modelPresetId: preset.id });
      await openPicker(page);
      await expect(radio(page, preset.gender === "women" ? "Women's figures" : "Men's figures")).toBeChecked();
      await expect(radio(page, preset.label)).toBeChecked();
      await expect(saveButton(page)).toBeDisabled();
    }
  });
});

test.describe("QA settings model picker: switching figure", () => {
  test("switching to men's and back keeps the women's choice until a men's figure is tapped", async ({ page }) => {
    const fake = await fakeSettings(page);
    await openPicker(page);
    await tap(page, "Women's, curvy build, deep skin tone");

    await tap(page, "Men's figures");
    // Nothing on the men's grid is checked; the choice is still the women's one, and says so.
    await expect(presetGrid(page).getByRole("radio", { checked: true })).toHaveCount(0);
    await expect(picker(page).getByText("Selected: Women's, curvy build, deep skin tone")).toBeVisible();
    await expect(saveButton(page)).toBeEnabled();

    await tap(page, "Women's figures");
    await expect(radio(page, "Women's, curvy build, deep skin tone")).toBeChecked();

    // A men's figure replaces it; going back to women's shows none checked.
    await tap(page, "Men's figures");
    await tap(page, "Men's, slim build, light skin tone");
    await tap(page, "Women's figures");
    await expect(presetGrid(page).getByRole("radio", { checked: true })).toHaveCount(0);
    await expect(picker(page).getByText("Selected: Men's, slim build, light skin tone")).toBeVisible();

    // What's saved is what "Selected" says, whichever figure is showing.
    await saveButton(page).click();
    await expect(currentModel(page)).toContainText("Men's, slim build, light skin tone");
    expect(fake.puts).toEqual([{ modelPresetId: "men_slim_light" }]);
  });

  test("switching figure alone doesn't make an unchanged choice saveable", async ({ page }) => {
    await fakeSettings(page);
    await openPicker(page);
    await tap(page, "Men's figures");
    await expect(saveButton(page)).toBeDisabled();
    await expect(picker(page).getByText(`Selected: ${DEFAULT_LABEL}`)).toBeVisible();
  });
});

test.describe("QA settings model picker: keyboard", () => {
  test("arrow keys move through and wrap around the presets; Tab reaches Save", async ({ page }) => {
    const fake = await fakeSettings(page, { modelPresetId: "women_slim_light" });
    await openPicker(page);
    const first = radio(page, "Women's, slim build, light skin tone");
    await first.focus();

    await page.keyboard.press("ArrowLeft"); // wraps to the last
    await expect(radio(page, "Women's, plus size build, deep skin tone")).toBeChecked();
    await expect(radio(page, "Women's, plus size build, deep skin tone")).toBeFocused();
    await page.keyboard.press("ArrowRight"); // wraps to the first
    await expect(first).toBeChecked();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown"); // end of the first row to the start of the next
    await expect(radio(page, "Women's, average build, light skin tone")).toBeChecked();
    await page.keyboard.press("ArrowUp");
    await expect(radio(page, "Women's, slim build, deep skin tone")).toBeChecked();
    await expect(picker(page).getByText("Selected: Women's, slim build, deep skin tone")).toBeVisible();

    // One tab stop per group: Tab leaves the grid for Cancel, then Save.
    await page.keyboard.press("Tab");
    await expect(picker(page).getByRole("button", { name: "Cancel" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(saveButton(page)).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByText("Model saved.")).toBeVisible();
    expect(fake.puts).toEqual([{ modelPresetId: "women_slim_deep" }]);
  });

  test("arrow keys switch figure, and Tab then lands on the presets", async ({ page }) => {
    await fakeSettings(page);
    await openPicker(page);
    await radio(page, "Women's figures").focus();
    await page.keyboard.press("ArrowRight");
    await expect(radio(page, "Men's figures")).toBeChecked();
    await expect(presetGrid(page).getByRole("radio", { name: /^Men's, / })).toHaveCount(12);
    await page.keyboard.press("ArrowLeft");
    await expect(radio(page, "Women's figures")).toBeChecked();
    await page.keyboard.press("Tab");
    await expect(radio(page, DEFAULT_LABEL)).toBeFocused();
    await page.keyboard.press("Space");
    await expect(radio(page, DEFAULT_LABEL)).toBeChecked();
  });

  test("Cancel by keyboard returns focus to the Change button", async ({ page }) => {
    await fakeSettings(page);
    await openPicker(page);
    await picker(page).getByRole("button", { name: "Cancel" }).focus();
    await page.keyboard.press("Enter");
    await expect(picker(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Change model" })).toBeFocused();
  });
});

test.describe("QA settings model picker: saves", () => {
  test("a double tap on Save sends one request", async ({ page }) => {
    const fake = await fakeSettings(page, {}, { onPut: () => new Promise((r) => setTimeout(r, 500)) });
    await openPicker(page);
    await tap(page, "Women's, plus size build, medium skin tone");
    await saveButton(page).dblclick();
    await expect(page.getByText("Model saved.")).toBeVisible();
    expect(fake.puts).toEqual([{ modelPresetId: "women_plus_medium" }]);
  });

  test("two quick taps from a touch screen send one request", async ({ page }) => {
    const fake = await fakeSettings(page, {}, { onPut: () => new Promise((r) => setTimeout(r, 500)) });
    await openPicker(page);
    await tap(page, "Women's, slim build, deep skin tone");
    await saveButton(page).scrollIntoViewIfNeeded();
    const box = (await saveButton(page).boundingBox())!;
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    await expect(page.getByText("Model saved.")).toBeVisible();
    expect(fake.puts).toHaveLength(1);
  });

  test("a slow save locks the picker, says Saving…, and ignores taps until it's done", async ({ page }) => {
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    const fake = await fakeSettings(page, {}, { onPut: () => released });
    await openPicker(page);
    await tap(page, "Women's, curvy build, medium skin tone");
    await saveButton(page).click();

    await expect(saveButton(page)).toHaveText("Saving…");
    await expect(saveButton(page)).toBeDisabled();
    await expect(picker(page).getByRole("button", { name: "Cancel" })).toBeDisabled();
    await expect(radio(page, "Women's, slim build, light skin tone")).toBeDisabled();
    await expect(radio(page, "Men's figures")).toBeDisabled();
    // A tap on another preset while saving changes nothing.
    await page.locator("label", { has: radio(page, "Women's, slim build, light skin tone") }).click({ force: true });
    await expect(radio(page, "Women's, curvy build, medium skin tone")).toBeChecked();
    await expect(currentModel(page)).toContainText(DEFAULT_LABEL);
    await expectNoSidewaysScroll(page);

    release();
    await expect(page.getByText("Model saved.")).toBeVisible();
    await expect(currentModel(page)).toContainText("Women's, curvy build, medium skin tone");
    expect(fake.puts).toEqual([{ modelPresetId: "women_curvy_medium" }]);
  });

  test("a failed save, then Cancel: the saved model stays, and reopening is clean", async ({ page }) => {
    const fake = await fakeSettings(page, {}, {
      onPut: async (route) => {
        await route.fulfill({ status: 500, json: { error: { code: "internal", message: "Something went wrong" } } });
        return "handled";
      },
    });
    await openPicker(page);
    await tap(page, "Men's figures");
    await tap(page, "Men's, plus size build, deep skin tone");
    await saveButton(page).click();
    await expect(picker(page).getByRole("alert")).toBeVisible();
    await expect(saveButton(page)).toBeEnabled();

    await picker(page).getByRole("button", { name: "Cancel" }).click();
    await expect(currentModel(page)).toContainText(DEFAULT_LABEL);
    await expect(page.getByText("Model saved.")).toHaveCount(0);

    await page.getByRole("button", { name: "Change model" }).click();
    await expect(picker(page).getByRole("alert")).toHaveCount(0);
    await expect(radio(page, "Women's figures")).toBeChecked();
    await expect(radio(page, DEFAULT_LABEL)).toBeChecked();
    expect(fake.puts).toHaveLength(1);
  });

  test("a save answered with a signed-out error goes to sign-in and back to settings, the saved model unchanged", async ({ page }) => {
    await fakeSettings(page, {}, {
      onPut: async (route) => {
        await route.fulfill({ status: 401, json: { error: { code: "unauthorized", message: "Sign in again" } } });
        return "handled";
      },
    });
    await openPicker(page);
    await tap(page, "Women's, slim build, medium skin tone");
    await saveButton(page).click();
    await expect(page).toHaveURL(/\/sign-in\?next=%2Fsettings&reason=expired$/);
  });

  test("a save whose reply isn't valid settings is treated as a failure", async ({ page }) => {
    await fakeSettings(page, {}, {
      onPut: async (route) => {
        // An unknown preset ID now reads as null (StoredModelPresetIdSchema), so
        // break a field that's still strict: the shop list.
        await route.fulfill({ json: { modelPresetId: "women_slim_medium", favouriteShopIds: "not-a-list", forwardingAddress: null } });
        return "handled";
      },
    });
    await openPicker(page);
    await tap(page, "Women's, slim build, medium skin tone");
    await saveButton(page).click();
    await expect(picker(page).getByRole("alert")).toBeVisible();
    await expect(currentModel(page)).toContainText(DEFAULT_LABEL);
    await expect(page.getByText("Model saved.")).toHaveCount(0);
  });

  test("Cancel after changing figure and preset restores the saved one, with no request", async ({ page }) => {
    const fake = await fakeSettings(page, { modelPresetId: "men_average_light" });
    await openPicker(page);
    await tap(page, "Women's figures");
    await tap(page, "Women's, plus size build, deep skin tone");
    await picker(page).getByRole("button", { name: "Cancel" }).click();

    await expect(picker(page)).toHaveCount(0);
    await expect(currentModel(page)).toContainText("Men's, average build, light skin tone");
    await page.getByRole("button", { name: "Change model" }).click();
    await expect(radio(page, "Men's figures")).toBeChecked();
    await expect(radio(page, "Men's, average build, light skin tone")).toBeChecked();
    await expect(saveButton(page)).toBeDisabled();
    expect(fake.puts).toEqual([]);
  });

  test("after a save, the Saved notice goes when the picker is opened again", async ({ page }) => {
    await fakeSettings(page);
    await openPicker(page);
    await tap(page, "Women's, slim build, medium skin tone");
    await saveButton(page).click();
    await expect(page.getByRole("status").filter({ hasText: "Model saved." })).toBeVisible();
    await page.getByRole("button", { name: "Change model" }).click();
    await expect(page.getByText("Model saved.")).toHaveCount(0);
    await expect(radio(page, "Women's, slim build, medium skin tone")).toBeChecked();
  });

  test("a stored preset ID that isn't on the list reads as not picked, and the rest of settings still works", async ({ page }) => {
    // E.g. a preset retired after a user picked it. The grid treats unknown IDs as none.
    // Was a bug: the whole GET /api/settings reply was rejected. Fixed by
    // StoredModelPresetIdSchema (unknown stored IDs read as null).
    const fake = await fakeSettings(page, { modelPresetId: "women_tall_light" });
    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: "Favourite shops" })).toBeVisible();
    await expect(currentModel(page)).toContainText("Not picked yet");
    await page.getByRole("button", { name: "Choose a model" }).click();
    await expect(radio(page, DEFAULT_LABEL)).toBeChecked();
    await expect(saveButton(page)).toBeEnabled();
    await saveButton(page).click();
    await expect(currentModel(page)).toContainText(DEFAULT_LABEL);
    expect(fake.puts).toEqual([{ modelPresetId: DEFAULT_PRESET }]);
  });
});

test.describe("QA settings model picker: edge cases", () => {
  test("blocked storage: settings loads, and a model can be picked and saved", async ({ page }) => {
    await page.addInitScript(() => {
      for (const name of ["localStorage", "sessionStorage"] as const) {
        Object.defineProperty(window, name, {
          configurable: true,
          get() {
            throw new DOMException("The operation is insecure.", "SecurityError");
          },
        });
      }
    });
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    const fake = await fakeSettings(page);
    await openPicker(page);
    await tap(page, "Men's figures");
    await tap(page, "Men's, broad build, medium skin tone");
    await saveButton(page).click();
    await expect(page.getByText("Model saved.")).toBeVisible();
    expect(fake.puts).toEqual([{ modelPresetId: "men_broad_medium" }]);
    expect(errors).toEqual([]);
  });

  test("no sideways scroll at 390 px in any state of the picker, and tap targets stay 44 px", async ({ page }) => {
    await fakeSettings(page, {}, {
      onPut: async (route) => {
        await route.fulfill({ status: 500, json: { error: { code: "internal", message: "Something went wrong" } } });
        return "handled";
      },
    });
    await page.goto("/settings");
    // Wait for the loaded screen, not the skeleton, before measuring.
    await expect(page.getByRole("checkbox", { name: "FatFace" })).toBeAttached();
    await expect(currentModel(page)).toContainText(DEFAULT_LABEL);
    await checkPhoneLayout(page, "settings");
    await page.getByRole("button", { name: "Change model" }).click();
    await checkPhoneLayout(page, "the women's grid");
    await tap(page, "Men's figures");
    await tap(page, "Men's, plus size build, medium skin tone");
    await checkPhoneLayout(page, "the men's grid");
    await saveButton(page).click();
    await expect(picker(page).getByRole("alert")).toBeVisible();
    await checkPhoneLayout(page, "the picker after a failed save");
    // The three tiles in a row share the width evenly.
    const widths = await presetGrid(page)
      .locator("label")
      .evaluateAll((els) => els.slice(0, 3).map((el) => Math.round(el.getBoundingClientRect().width)));
    expect(new Set(widths).size).toBe(1);
    expect(widths[0]).toBeGreaterThanOrEqual(44);
  });

  test("preset pictures that fail to load leave a usable grid of the same shape", async ({ page }) => {
    await page.route("**/presets/*.webp", (route) => route.abort());
    const fake = await fakeSettings(page);
    await openPicker(page);
    const tiles = presetGrid(page).locator("label");
    await expect(tiles).toHaveCount(12);
    // Each picture keeps its 2:3 box, so the grid doesn't collapse or jump.
    const sizes = await presetGrid(page)
      .locator("img")
      .evaluateAll((imgs) => imgs.map((img) => ({ w: Math.round(img.getBoundingClientRect().width), h: Math.round(img.getBoundingClientRect().height) })));
    for (const { w, h } of sizes) {
      expect(w).toBeGreaterThan(44);
      expect(Math.abs(h - (w * 3) / 2)).toBeLessThanOrEqual(1);
    }
    // No alt text spills into the tile; the caption still says the tone.
    await expect(presetGrid(page).locator("img:not([alt=''])")).toHaveCount(0);
    await expect(tiles.first()).toContainText("Light skin");
    await checkPhoneLayout(page, "the picker with broken pictures");

    await tap(page, "Women's, plus size build, light skin tone");
    await saveButton(page).click();
    await expect(currentModel(page)).toContainText("Women's, plus size build, light skin tone");
    expect(fake.puts).toEqual([{ modelPresetId: "women_plus_light" }]);
  });
});

test.describe("QA settings model picker: other settings sections", () => {
  test("saving the model sends only the model, and shops save afterwards with only the shops", async ({ page }) => {
    const fake = await fakeSettings(page, { favouriteShopIds: ["next", "asos"] });
    await openPicker(page);
    await tap(page, "Women's, slim build, light skin tone");
    await saveButton(page).click();
    await expect(page.getByText("Model saved.")).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "Next" })).toBeChecked();
    await expect(page.getByRole("checkbox", { name: "ASOS" })).toBeChecked();

    await page.getByText("Zara", { exact: true }).click();
    await page.getByRole("button", { name: "Save shops" }).click();
    await expect(page.getByText("Shops saved.")).toBeVisible();
    // The model notice and the saved model survive the shops save.
    await expect(currentModel(page)).toContainText("Women's, slim build, light skin tone");
    expect(fake.puts).toEqual([{ modelPresetId: "women_slim_light" }, { favouriteShopIds: expect.arrayContaining(["next", "asos", "zara"]) }]);
    expect(fake.puts[1]).not.toHaveProperty("modelPresetId");
  });

  test("an open picker with an unsaved choice survives a shops save", async ({ page }) => {
    await fakeSettings(page);
    await openPicker(page);
    await tap(page, "Women's, curvy build, light skin tone");
    await page.getByText("Zara", { exact: true }).click();
    await page.getByRole("button", { name: "Save shops" }).click();
    await expect(page.getByText("Shops saved.")).toBeVisible();
    await expect(picker(page)).toBeVisible();
    await expect(radio(page, "Women's, curvy build, light skin tone")).toBeChecked();
    await expect(currentModel(page)).toContainText(DEFAULT_LABEL);
  });

  test("with forwarding set up, the forwarding address and email imports still show below the model", async ({ page }) => {
    await fakeSettings(page, { forwardingAddress: "0123456789abcdef0123456789abcdef@in.example.com" });
    await page.goto("/settings");
    const headings = page.getByRole("heading", { level: 2 });
    await expect(headings.first()).toHaveText("Your model");
    await expect(page.getByTestId("forwarding-address")).toHaveText("0123456789abcdef0123456789abcdef@in.example.com");
    await expect(page.getByRole("heading", { name: "Favourite shops" })).toBeVisible();
    await page.getByRole("button", { name: "Change model" }).click();
    await checkPhoneLayout(page, "settings with forwarding and an open picker");
  });
});
