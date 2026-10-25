// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NO_FILTERS, type WardrobeFilters } from "./wardrobe-filter-values";
import { WardrobeFiltersBar } from "./wardrobe-filters";

afterEach(cleanup);

/** The bar is controlled; this keeps its state like the wardrobe screen does. */
function Harness({ initial = NO_FILTERS, onChange }: { initial?: WardrobeFilters; onChange: (f: WardrobeFilters) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <WardrobeFiltersBar
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange(next);
      }}
    />
  );
}

describe("WardrobeFiltersBar", () => {
  it("offers category, colour and occasion filters with every contract value", () => {
    render(<Harness onChange={vi.fn()} />);
    const category = screen.getByRole("combobox", { name: "Category" });
    expect(category).toHaveValue("");
    // "Category" (all), then the five categories.
    expect(screen.getAllByRole("option").filter((o) => category.contains(o))).toHaveLength(6);
    expect(screen.getByRole("option", { name: "Dress or jumpsuit" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Light blue" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Wedding guest" })).toBeInTheDocument();
  });

  it("reports each filter as it's chosen", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await user.selectOptions(screen.getByRole("combobox", { name: "Category" }), "Shoes");
    await user.selectOptions(screen.getByRole("combobox", { name: "Colour" }), "Tan");
    await user.selectOptions(screen.getByRole("combobox", { name: "Occasion" }), "Work");
    expect(onChange).toHaveBeenLastCalledWith({ category: "shoes", colour: "tan", occasion: "work", q: "" });
  });

  it("searches descriptions as you type", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await user.type(screen.getByRole("searchbox", { name: "Search descriptions" }), "linen");
    expect(onChange).toHaveBeenLastCalledWith({ ...NO_FILTERS, q: "linen" });
  });

  it("shows Clear filters only when something is set, and clears everything", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial={{ category: "top", colour: "navy", occasion: "", q: "shirt" }} onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(onChange).toHaveBeenLastCalledWith(NO_FILTERS);
    expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
    expect(screen.getByRole("combobox", { name: "Category" })).toHaveValue("");
  });
});
