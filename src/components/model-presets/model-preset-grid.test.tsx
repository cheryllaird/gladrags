// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MODEL_PRESET_ID, MODEL_PRESETS, MODEL_PRESETS_BY_ID } from "@/contracts";
import { ModelPresetGrid, presetCaption, presetsFor } from "./model-preset-grid";

afterEach(cleanup);

describe("ModelPresetGrid", () => {
  it("offers all 24 presets as radios, with the chosen one checked", () => {
    render(<ModelPresetGrid value={DEFAULT_MODEL_PRESET_ID} onChange={() => {}} />);
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(24);
    expect(screen.getByRole("radio", { name: MODEL_PRESETS_BY_ID.get(DEFAULT_MODEL_PRESET_ID)!.label })).toBeChecked();
    expect(screen.getByRole("group", { name: "Women's figures" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Men's figures" })).toBeInTheDocument();
  });

  it("shows each preset's picture from its image path", () => {
    const { container } = render(<ModelPresetGrid value={DEFAULT_MODEL_PRESET_ID} onChange={() => {}} />);
    const sources = [...container.querySelectorAll("img")].map((img) => img.getAttribute("src"));
    expect(sources.sort()).toEqual(MODEL_PRESETS.map((p) => p.imagePath).sort());
  });

  it("reports a new choice", async () => {
    const onChange = vi.fn();
    render(<ModelPresetGrid value={DEFAULT_MODEL_PRESET_ID} onChange={onChange} />);
    await userEvent.click(screen.getByRole("radio", { name: "Men's, broad build, deep skin tone" }));
    expect(onChange).toHaveBeenCalledWith("men_broad_deep");
  });

  it("orders each figure by build, then skin tone, with short captions", () => {
    expect(presetsFor("men").map((p) => p.id).slice(0, 4)).toEqual(["men_slim_light", "men_slim_medium", "men_slim_deep", "men_average_light"]);
    expect(presetCaption(MODEL_PRESETS_BY_ID.get("women_plus_deep")!)).toBe("Plus size, deep");
  });
});
