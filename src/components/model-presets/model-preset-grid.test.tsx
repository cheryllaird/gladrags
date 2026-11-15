// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MODEL_PRESETS, type ModelPresetId } from "@/contracts";
import { ModelPresetGrid } from "./model-preset-grid";
import { findPreset, genderOf, presetRows } from "./presets";

afterEach(cleanup);

function Controlled({ initial = null, onChange }: { initial?: ModelPresetId | null; onChange?: (id: ModelPresetId) => void }) {
  const [value, setValue] = useState<ModelPresetId | null>(initial);
  return (
    <ModelPresetGrid
      value={value}
      onChange={(id) => {
        setValue(id);
        onChange?.(id);
      }}
    />
  );
}

function presetRadios() {
  return within(screen.getByTestId("model-preset-grid")).getAllByRole("radio");
}

describe("presets helpers", () => {
  it("lays each figure out as 4 builds × 3 skin tones, in the contract's order", () => {
    expect(presetRows("women").map((r) => r.build)).toEqual(["slim", "average", "curvy", "plus"]);
    expect(presetRows("men").map((r) => r.build)).toEqual(["slim", "average", "broad", "plus"]);
    for (const gender of ["women", "men"] as const) {
      const rows = presetRows(gender);
      for (const row of rows) expect(row.presets.map((p) => p.skinTone)).toEqual(["light", "medium", "deep"]);
      expect(rows.flatMap((r) => r.presets)).toEqual(MODEL_PRESETS.filter((p) => p.gender === gender));
    }
  });

  it("finds presets and their figure, and treats unknown IDs as none", () => {
    expect(findPreset("men_broad_deep")?.label).toBe("Men's, broad build, deep skin tone");
    expect(findPreset(null)).toBeNull();
    expect(findPreset("women_tall_light")).toBeNull();
    expect(genderOf("men_slim_light")).toBe("men");
    expect(genderOf(null)).toBe("women");
    expect(genderOf("nonsense")).toBe("women");
  });
});

describe("ModelPresetGrid", () => {
  it("is a radio group of 12 presets per figure, each named with its build and skin tone", () => {
    render(<Controlled />);
    expect(screen.getByRole("group", { name: "Model: Women's figures" })).toBeInTheDocument();
    const radios = presetRadios();
    expect(radios).toHaveLength(12);
    expect(radios.every((r) => !(r as HTMLInputElement).checked)).toBe(true);
    expect(screen.getByRole("radio", { name: "Women's, curvy build, deep skin tone" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Women's, plus size build, light skin tone" })).toBeInTheDocument();
    // Visible labels: a heading per build and a caption per tone.
    for (const text of ["Slim build", "Average build", "Curvy build", "Plus size"]) expect(screen.getByText(text)).toBeInTheDocument();
    expect(screen.getAllByText("Medium skin")).toHaveLength(4);
  });

  it("opens on the figure of the selected preset and shows it selected", () => {
    render(<Controlled initial="men_average_deep" />);
    expect(screen.getByRole("radio", { name: "Men's figures" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Men's, average build, deep skin tone" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Men's, broad build, deep skin tone" })).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: /^Women's, / })).toBeNull();
  });

  it("switches figure without changing the selection, and calls onChange with the tapped preset", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Controlled initial="women_slim_light" onChange={onChange} />);
    await user.click(screen.getByRole("radio", { name: "Men's figures" }));
    expect(onChange).not.toHaveBeenCalled();
    expect(presetRadios().every((r) => !(r as HTMLInputElement).checked)).toBe(true);

    await user.click(screen.getByRole("radio", { name: "Men's, plus size build, medium skin tone" }));
    expect(onChange).toHaveBeenCalledWith("men_plus_medium");
    expect(screen.getByRole("radio", { name: "Men's, plus size build, medium skin tone" })).toBeChecked();

    await user.click(screen.getByRole("radio", { name: "Women's figures" }));
    expect(presetRadios().every((r) => !(r as HTMLInputElement).checked)).toBe(true);
  });

  it("moves between presets with the arrow keys, as a radio group", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Controlled initial="women_slim_light" onChange={onChange} />);
    screen.getByRole("radio", { name: "Women's, slim build, light skin tone" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(onChange).toHaveBeenLastCalledWith("women_slim_medium");
    expect(screen.getByRole("radio", { name: "Women's, slim build, medium skin tone" })).toHaveFocus();
  });

  it("takes the figure from props when given", async () => {
    const user = userEvent.setup();
    const onGenderChange = vi.fn();
    const { rerender } = render(<ModelPresetGrid value={null} onChange={() => {}} gender="men" onGenderChange={onGenderChange} />);
    expect(screen.getByRole("radio", { name: "Men's figures" })).toBeChecked();
    await user.click(screen.getByRole("radio", { name: "Women's figures" }));
    expect(onGenderChange).toHaveBeenCalledWith("women");
    // Still men's until the parent says otherwise.
    expect(screen.getByRole("radio", { name: "Men's figures" })).toBeChecked();
    rerender(<ModelPresetGrid value={null} onChange={() => {}} gender="women" onGenderChange={onGenderChange} />);
    expect(screen.getByRole("radio", { name: "Women's figures" })).toBeChecked();
  });

  it("switches to the figure of a new value set from outside (e.g. settings loading after mount)", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<ModelPresetGrid value={null} onChange={() => {}} />);
    expect(screen.getByRole("radio", { name: "Women's figures" })).toBeChecked();
    rerender(<ModelPresetGrid value="men_plus_light" onChange={() => {}} />);
    expect(screen.getByRole("radio", { name: "Men's figures" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Men's, plus size build, light skin tone" })).toBeChecked();
    // The user can still look at the other figure while the value stays put.
    await user.click(screen.getByRole("radio", { name: "Women's figures" }));
    rerender(<ModelPresetGrid value="men_plus_light" onChange={() => {}} />);
    expect(screen.getByRole("radio", { name: "Women's figures" })).toBeChecked();
    // A controlled figure wins over the value's.
    rerender(<ModelPresetGrid value="women_slim_deep" onChange={() => {}} gender="men" />);
    expect(screen.getByRole("radio", { name: "Men's figures" })).toBeChecked();
  });

  it("can't be changed while disabled", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ModelPresetGrid value="women_average_medium" onChange={onChange} disabled />);
    for (const radio of screen.getAllByRole("radio")) expect(radio).toBeDisabled();
    await user.click(screen.getByRole("radio", { name: "Women's, slim build, deep skin tone" }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("shows each preset's picture from public/presets", () => {
    render(<Controlled />);
    const images = within(screen.getByTestId("model-preset-grid")).getAllByRole("presentation", { hidden: true });
    expect(images.map((img) => img.getAttribute("src"))).toEqual(presetRows("women").flatMap((r) => r.presets.map((p) => p.imagePath)));
  });
});
