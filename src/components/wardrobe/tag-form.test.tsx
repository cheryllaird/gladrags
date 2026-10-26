// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ItemTags } from "@/contracts";
import { TagForm } from "./tag-form";

const SHIRT: ItemTags = {
  category: "top",
  subcategory: "shirt",
  colours: ["navy", "white"],
  pattern: "stripe",
  formality: 2,
  seasons: ["spring", "summer"],
  warmth: "light",
  occasions: ["casual", "smart_casual"],
  fabric: "linen",
  description: "Navy and white striped linen shirt",
};

afterEach(cleanup);

// jsdom has no layout, so scrollIntoView doesn't exist.
Element.prototype.scrollIntoView = vi.fn();

function group(name: string) {
  return screen.getByRole("group", { name });
}

function renderForm(initialTags: ItemTags | null, onSubmit = vi.fn()) {
  const user = userEvent.setup();
  render(<TagForm initialTags={initialTags} submitLabel="Save to wardrobe" onSubmit={onSubmit} onCancel={vi.fn()} cancelLabel="Discard" />);
  return { user, onSubmit, save: () => user.click(screen.getByRole("button", { name: "Save to wardrobe" })) };
}

describe("TagForm with suggested tags", () => {
  it("shows every suggested tag pre-filled", () => {
    renderForm(SHIRT);
    expect(within(group("Category")).getByRole("radio", { name: "Top" })).toBeChecked();
    expect(within(group("Type")).getByRole("radio", { name: "Shirt" })).toBeChecked();
    expect(within(group("Colours")).getByRole("checkbox", { name: /Navy/ })).toBeChecked();
    expect(within(group("Colours")).getByRole("checkbox", { name: /White/ })).toBeChecked();
    expect(within(group("Pattern")).getByRole("radio", { name: "Stripe" })).toBeChecked();
    expect(within(group("Formality")).getByRole("radio", { name: /^2/ })).toBeChecked();
    expect(within(group("Seasons")).getByRole("checkbox", { name: "Summer" })).toBeChecked();
    expect(within(group("Warmth")).getByRole("radio", { name: "Light" })).toBeChecked();
    expect(within(group("Occasions")).getByRole("checkbox", { name: "Smart casual" })).toBeChecked();
    expect(screen.getByLabelText(/Fabric/)).toHaveValue("linen");
    expect(screen.getByLabelText("Description")).toHaveValue("Navy and white striped linen shirt");
  });

  it("marks the first colour as the main one", () => {
    renderForm(SHIRT);
    expect(within(group("Colours")).getByRole("checkbox", { name: /Navy.*main/ })).toBeChecked();
  });

  it("saves unchanged tags as not edited", async () => {
    const { save, onSubmit } = renderForm(SHIRT);
    await save();
    expect(onSubmit).toHaveBeenCalledWith(SHIRT, false);
  });

  it("saves changed tags as edited", async () => {
    const { user, save, onSubmit } = renderForm(SHIRT);
    await user.click(within(group("Pattern")).getByRole("radio", { name: "Plain" }));
    await user.click(within(group("Seasons")).getByRole("checkbox", { name: "Autumn" }));
    await save();
    expect(onSubmit).toHaveBeenCalledWith(
      { ...SHIRT, pattern: "plain", seasons: ["spring", "summer", "autumn"] },
      true,
    );
  });

  it("changing the category offers that category's types and asks for one again", async () => {
    const { user, save, onSubmit } = renderForm(SHIRT);
    await user.click(within(group("Category")).getByRole("radio", { name: "Bottom" }));
    const types = within(group("Type"));
    expect(types.queryByRole("radio", { name: "Shirt" })).toBeNull();
    expect(types.getByRole("radio", { name: "Chinos" })).not.toBeChecked();

    await save();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(within(group("Type")).getByText("Choose a type")).toBeInTheDocument();

    await user.click(within(group("Type")).getByRole("radio", { name: "Chinos" }));
    await save();
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ category: "bottom", subcategory: "chinos" }), true);
  });

  it("allows at most three colours", async () => {
    const { user } = renderForm(SHIRT);
    const colours = within(group("Colours"));
    await user.click(colours.getByRole("checkbox", { name: /Red/ }));
    expect(colours.getByRole("checkbox", { name: /Red/ })).toBeChecked();
    expect(colours.getByRole("checkbox", { name: /Black/ })).toBeDisabled();
    await user.click(colours.getByRole("checkbox", { name: /White/ }));
    expect(colours.getByRole("checkbox", { name: /Black/ })).toBeEnabled();
  });

  it("refuses a cleared description", async () => {
    const { user, save, onSubmit } = renderForm(SHIRT);
    await user.clear(screen.getByLabelText("Description"));
    await save();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText("Add a short description")).toBeInTheDocument();
    expect(screen.getByLabelText("Description")).toHaveAttribute("aria-invalid", "true");
  });
});

describe("TagForm with empty tags (tagging failed)", () => {
  it("starts with nothing chosen and asks for a category before showing types", () => {
    renderForm(null);
    for (const radio of within(group("Category")).getAllByRole("radio")) expect(radio).not.toBeChecked();
    expect(within(group("Type")).getByText("Choose a category first.")).toBeInTheDocument();
    expect(screen.getByLabelText("Description")).toHaveValue("");
  });

  it("lists what's missing on save and moves focus to the first problem", async () => {
    const { save, onSubmit } = renderForm(null);
    await save();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("9 things to fix before saving.");
    expect(within(group("Category")).getByText("Choose a category")).toBeInTheDocument();
    expect(within(group("Occasions")).getByText("Choose at least one occasion")).toBeInTheDocument();
    expect(within(group("Category")).getByRole("radio", { name: "Top" })).toHaveFocus();
  });

  it("clears each message as it's fixed", async () => {
    const { user, save } = renderForm(null);
    await save();
    await user.click(within(group("Category")).getByRole("radio", { name: "Shoes" }));
    expect(within(group("Category")).queryByText("Choose a category")).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent("8 things to fix");
  });

  it("saves once every tag is filled in, and counts it as edited", async () => {
    const { user, save, onSubmit } = renderForm(null);
    await user.click(within(group("Category")).getByRole("radio", { name: "Shoes" }));
    await user.click(within(group("Type")).getByRole("radio", { name: "Loafers" }));
    await user.click(within(group("Colours")).getByRole("checkbox", { name: /Tan/ }));
    await user.click(within(group("Pattern")).getByRole("radio", { name: "Plain" }));
    await user.click(within(group("Formality")).getByRole("radio", { name: /^3/ }));
    await user.click(within(group("Seasons")).getByRole("checkbox", { name: "Spring" }));
    await user.click(within(group("Warmth")).getByRole("radio", { name: "Medium" }));
    await user.click(within(group("Occasions")).getByRole("checkbox", { name: "Work" }));
    await user.type(screen.getByLabelText("Description"), "Tan suede loafers");
    await save();
    expect(onSubmit).toHaveBeenCalledWith(
      {
        category: "shoes",
        subcategory: "loafers",
        colours: ["tan"],
        pattern: "plain",
        formality: 3,
        seasons: ["spring"],
        warmth: "medium",
        occasions: ["work"],
        fabric: null,
        description: "Tan suede loafers",
      },
      true,
    );
  });
});

describe("TagForm while saving", () => {
  it("disables the buttons and shows progress", () => {
    render(<TagForm initialTags={SHIRT} submitLabel="Save tags" busy onSubmit={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  });
});
