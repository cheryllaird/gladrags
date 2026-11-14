// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UserSettings } from "@/contracts";
import { ApiClientError } from "@/lib/client/api";
import { ModelPresetSetting } from "./model-preset-setting";

vi.mock("@/lib/client/api", async (original) => {
  const actual = await original<typeof import("@/lib/client/api")>();
  return { ...actual, updateModelPreset: vi.fn() };
});
const api = await import("@/lib/client/api");

const SETTINGS: UserSettings = { modelPresetId: "women_average_medium", favouriteShopIds: ["next"], forwardingAddress: null };

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** The section as the settings screen uses it: what's saved comes back through onSaved. */
function Harness({ initial }: { initial: string | null }) {
  const [saved, setSaved] = useState<string | null>(initial);
  return <ModelPresetSetting saved={saved} onSaved={(s) => setSaved(s.modelPresetId)} />;
}

function current() {
  return screen.getByTestId("current-model");
}

describe("ModelPresetSetting", () => {
  it("shows the saved model and says what changing it does", () => {
    render(<Harness initial="men_broad_light" />);
    expect(screen.getByRole("heading", { name: "Your model" })).toBeInTheDocument();
    expect(current()).toHaveTextContent("Men's, broad build, light skin tone");
    expect(screen.getByText("Previews of new outfits use this model. Existing previews stay as they are.")).toBeInTheDocument();
    expect(screen.queryByTestId("model-picker")).toBeNull();
  });

  it("says when none is picked yet, and opens on the default", async () => {
    const user = userEvent.setup();
    render(<Harness initial={null} />);
    expect(current()).toHaveTextContent("Not picked yet");
    await user.click(screen.getByRole("button", { name: "Choose a model" }));
    expect(screen.getByRole("radio", { name: "Women's, average build, medium skin tone" })).toBeChecked();
    // Nothing saved yet, so the default can be saved as it is.
    expect(screen.getByRole("button", { name: "Save model" })).toBeEnabled();
  });

  it("changes the model: picks a men's figure, saves, and shows the new one", async () => {
    const user = userEvent.setup();
    let resolve!: (s: UserSettings) => void;
    vi.mocked(api.updateModelPreset).mockImplementation(() => new Promise((r) => (resolve = r)));
    render(<Harness initial="women_average_medium" />);

    await user.click(screen.getByRole("button", { name: "Change model" }));
    expect(screen.getByRole("radio", { name: "Women's, average build, medium skin tone" })).toBeChecked();
    // The saved one again: nothing to save.
    expect(screen.getByRole("button", { name: "Save model" })).toBeDisabled();

    await user.click(screen.getByRole("radio", { name: "Men's figures" }));
    await user.click(screen.getByRole("radio", { name: "Men's, slim build, deep skin tone" }));
    expect(screen.getByText("Selected: Men's, slim build, deep skin tone")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save model" }));

    expect(api.updateModelPreset).toHaveBeenCalledWith("men_slim_deep");
    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    for (const radio of within(screen.getByTestId("model-preset-grid")).getAllByRole("radio")) expect(radio).toBeDisabled();
    // Still the old one until the server answers.
    expect(current()).toHaveTextContent("Women's, average build, medium skin tone");

    resolve({ ...SETTINGS, modelPresetId: "men_slim_deep" });
    expect(await screen.findByText("Model saved.")).toBeInTheDocument();
    expect(current()).toHaveTextContent("Men's, slim build, deep skin tone");
    expect(screen.queryByTestId("model-picker")).toBeNull();
  });

  it("keeps the old model when saving fails, and lets the user try again", async () => {
    const user = userEvent.setup();
    vi.mocked(api.updateModelPreset).mockRejectedValueOnce(new ApiClientError("network", "offline"));
    vi.mocked(api.updateModelPreset).mockResolvedValueOnce({ ...SETTINGS, modelPresetId: "women_plus_deep" });
    render(<Harness initial="women_average_medium" />);

    await user.click(screen.getByRole("button", { name: "Change model" }));
    await user.click(screen.getByRole("radio", { name: "Women's, plus size build, deep skin tone" }));
    await user.click(screen.getByRole("button", { name: "Save model" }));

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(current()).toHaveTextContent("Women's, average build, medium skin tone");
    // The picker stays open with the user's choice.
    expect(screen.getByRole("radio", { name: "Women's, plus size build, deep skin tone" })).toBeChecked();

    await user.click(screen.getByRole("button", { name: "Save model" }));
    expect(await screen.findByText("Model saved.")).toBeInTheDocument();
    expect(current()).toHaveTextContent("Women's, plus size build, deep skin tone");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("cancel closes the picker without saving and returns focus to Change", async () => {
    const user = userEvent.setup();
    render(<Harness initial="women_average_medium" />);
    await user.click(screen.getByRole("button", { name: "Change model" }));
    await user.click(screen.getByRole("radio", { name: "Women's, slim build, light skin tone" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(api.updateModelPreset).not.toHaveBeenCalled();
    expect(screen.queryByTestId("model-picker")).toBeNull();
    expect(current()).toHaveTextContent("Women's, average build, medium skin tone");
    await vi.waitFor(() => expect(screen.getByRole("button", { name: "Change model" })).toHaveFocus());

    // Opening again starts from the saved one, not the abandoned choice.
    await user.click(screen.getByRole("button", { name: "Change model" }));
    expect(screen.getByRole("radio", { name: "Women's, average build, medium skin tone" })).toBeChecked();
  });
});
