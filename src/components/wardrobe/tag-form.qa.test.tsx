// @vitest-environment jsdom
// QA tests for the tag review form (wardrobe-ui): per-field validation, the
// three-colour limit with the first as main, subcategories following the
// category, and tagsEdited being true only when something really changed.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DESCRIPTION_MAX_LENGTH, SUBCATEGORIES, type ItemTags } from "@/contracts";
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

const NO_FABRIC: ItemTags = { ...SHIRT, fabric: null };

afterEach(cleanup);
Element.prototype.scrollIntoView = vi.fn();

function group(name: string) {
  return within(screen.getByRole("group", { name }));
}

function renderForm(initialTags: ItemTags | null) {
  const user = userEvent.setup();
  const onSubmit = vi.fn();
  render(<TagForm initialTags={initialTags} submitLabel="Save" onSubmit={onSubmit} onCancel={vi.fn()} />);
  const save = () => user.click(screen.getByRole("button", { name: "Save" }));
  return { user, onSubmit, save };
}

/** Labels of the type chips currently offered. */
function typeOptions(): string[] {
  return group("Type")
    .queryAllByRole("radio")
    .map((radio) => radio.closest("label")!.textContent!.trim());
}

describe("colours: up to three, the first is the main colour", () => {
  it("keeps the order chosen, so the first pick stays the main colour", async () => {
    const { user, save } = renderForm(null);
    const colours = group("Colours");
    await user.click(colours.getByRole("checkbox", { name: /Olive/ }));
    await user.click(colours.getByRole("checkbox", { name: /Black/ }));
    await user.click(colours.getByRole("checkbox", { name: /Cream/ }));
    expect(colours.getByRole("checkbox", { name: /Olive.*main/ })).toBeChecked();
    expect(colours.getByRole("checkbox", { name: /Black/ })).not.toHaveAccessibleName(/main/);
    await save();
    // Form is incomplete, but colours are not among the problems.
    expect(screen.queryByText("Choose at least one colour")).toBeNull();
  });

  it("moves 'main' to the next colour when the main one is removed, and saves it first", async () => {
    const { user, save, onSubmit } = renderForm(SHIRT);
    const colours = group("Colours");
    await user.click(colours.getByRole("checkbox", { name: /Red/ }));
    await user.click(colours.getByRole("checkbox", { name: /Navy/ }));
    expect(colours.getByRole("checkbox", { name: /White.*main/ })).toBeChecked();
    await save();
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ colours: ["white", "red"] }), true);
  });

  it("disables every unchosen colour at three, and refuses to save with none", async () => {
    const { user, save, onSubmit } = renderForm(SHIRT);
    const colours = group("Colours");
    await user.click(colours.getByRole("checkbox", { name: /Teal/ }));
    const enabled = colours.getAllByRole("checkbox").filter((box) => !(box as HTMLInputElement).disabled);
    expect(enabled).toHaveLength(3);

    for (const name of [/Navy/, /White/, /Teal/]) await user.click(colours.getByRole("checkbox", { name }));
    await save();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(group("Colours").getByText("Choose at least one colour")).toBeInTheDocument();
  });
});

describe("subcategory follows the category", () => {
  it.each(Object.entries(SUBCATEGORIES))("offers exactly the %s types", async (category, subcategories) => {
    const { user } = renderForm(null);
    const label = { top: "Top", bottom: "Bottom", dress_jumpsuit: "Dress or jumpsuit", outerwear: "Outerwear", shoes: "Shoes" }[
      category
    ]!;
    await user.click(group("Category").getByRole("radio", { name: label }));
    expect(group("Type").getAllByRole("radio")).toHaveLength(subcategories.length);
    for (const radio of group("Type").getAllByRole("radio")) {
      expect(subcategories as readonly string[]).toContain((radio as HTMLInputElement).value);
    }
  });

  it("clears the chosen type when the category changes, and doesn't bring it back on changing back", async () => {
    const { user, save, onSubmit } = renderForm(SHIRT);
    await user.click(group("Category").getByRole("radio", { name: "Shoes" }));
    expect(typeOptions()).toContain("Trainers");
    expect(group("Type").queryAllByRole("radio").filter((r) => (r as HTMLInputElement).checked)).toHaveLength(0);

    await user.click(group("Category").getByRole("radio", { name: "Top" }));
    expect(group("Type").getByRole("radio", { name: "Shirt" })).not.toBeChecked();
    await save();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(group("Type").getByText("Choose a type")).toBeInTheDocument();
  });

  it("re-tapping the same category keeps the type", async () => {
    const { user, save, onSubmit } = renderForm(SHIRT);
    await user.click(group("Category").getByRole("radio", { name: "Top" }));
    expect(group("Type").getByRole("radio", { name: "Shirt" })).toBeChecked();
    await save();
    expect(onSubmit).toHaveBeenCalledWith(SHIRT, false);
  });
});

describe("each field's validation", () => {
  it("refuses a description of only spaces", async () => {
    const { user, save, onSubmit } = renderForm(SHIRT);
    const description = screen.getByLabelText("Description");
    await user.clear(description);
    await user.type(description, "    ");
    await save();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText("Add a short description")).toBeInTheDocument();
    expect(description).toHaveFocus();
  });

  it("accepts a description of exactly the maximum length, and the input stops there", async () => {
    const { user, save, onSubmit } = renderForm(SHIRT);
    const description = screen.getByLabelText("Description");
    await user.clear(description);
    await user.type(description, "x".repeat(DESCRIPTION_MAX_LENGTH + 5));
    expect(description).toHaveValue("x".repeat(DESCRIPTION_MAX_LENGTH));
    expect(screen.getByText(new RegExp(`${DESCRIPTION_MAX_LENGTH}/${DESCRIPTION_MAX_LENGTH}`))).toBeInTheDocument();
    await save();
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ description: "x".repeat(DESCRIPTION_MAX_LENGTH) }), true);
  });

  it("trims the description before saving", async () => {
    const { user, save, onSubmit } = renderForm(SHIRT);
    const description = screen.getByLabelText("Description");
    await user.clear(description);
    await user.type(description, "  Blue shirt  ");
    await save();
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ description: "Blue shirt" }), true);
  });

  it("saves a fabric of only spaces as no fabric", async () => {
    const { user, save, onSubmit } = renderForm(SHIRT);
    const fabric = screen.getByLabelText(/Fabric/);
    await user.clear(fabric);
    await user.type(fabric, "   ");
    await save();
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ fabric: null }), true);
  });

  it("asks only for what's missing and focuses that field (occasions)", async () => {
    const { user, save, onSubmit } = renderForm(SHIRT);
    await user.click(group("Occasions").getByRole("checkbox", { name: "Casual" }));
    await user.click(group("Occasions").getByRole("checkbox", { name: "Smart casual" }));
    await save();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("1 thing to fix before saving.");
    expect(group("Occasions").getByText("Choose at least one occasion")).toBeInTheDocument();
    expect(group("Occasions").getByRole("checkbox", { name: "Comfy" })).toHaveFocus();
  });

  it("asks for seasons when all are removed", async () => {
    const { user, save, onSubmit } = renderForm(SHIRT);
    await user.click(group("Seasons").getByRole("checkbox", { name: "Spring" }));
    await user.click(group("Seasons").getByRole("checkbox", { name: "Summer" }));
    await save();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(group("Seasons").getByText("Choose at least one season")).toBeInTheDocument();
  });

  it("offers formality 1 to 5 and nothing else", () => {
    renderForm(null);
    const values = group("Formality")
      .getAllByRole("radio")
      .map((radio) => (radio as HTMLInputElement).value);
    expect(values).toEqual(["1", "2", "3", "4", "5"]);
  });

  it("the error summary disappears once everything is fixed", async () => {
    const { user, save } = renderForm(SHIRT);
    await user.clear(screen.getByLabelText("Description"));
    await save();
    expect(screen.getByRole("alert")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Description"), "Shirt");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("tagsEdited is true only when something actually changed", () => {
  it("false after changing a tag and changing it back", async () => {
    const { user, save, onSubmit } = renderForm(SHIRT);
    await user.click(group("Pattern").getByRole("radio", { name: "Floral" }));
    await user.click(group("Pattern").getByRole("radio", { name: "Stripe" }));
    await save();
    expect(onSubmit).toHaveBeenCalledWith(SHIRT, false);
  });

  it("false after removing and re-adding a season or occasion (order doesn't matter there)", async () => {
    const { user, save, onSubmit } = renderForm(SHIRT);
    await user.click(group("Seasons").getByRole("checkbox", { name: "Spring" }));
    await user.click(group("Seasons").getByRole("checkbox", { name: "Spring" }));
    await user.click(group("Occasions").getByRole("checkbox", { name: "Casual" }));
    await user.click(group("Occasions").getByRole("checkbox", { name: "Casual" }));
    await save();
    expect(onSubmit.mock.calls[0]![1]).toBe(false);
  });

  it("false when only spaces were added around the description", async () => {
    const { user, save, onSubmit } = renderForm(SHIRT);
    await user.type(screen.getByLabelText("Description"), "   ");
    await save();
    expect(onSubmit).toHaveBeenCalledWith(SHIRT, false);
  });

  it("false when spaces are typed into an empty fabric", async () => {
    const { user, save, onSubmit } = renderForm(NO_FABRIC);
    await user.type(screen.getByLabelText(/Fabric/), "  ");
    await save();
    expect(onSubmit).toHaveBeenCalledWith(NO_FABRIC, false);
  });

  it("false when the category is changed and changed back with the same type re-chosen", async () => {
    const { user, save, onSubmit } = renderForm(SHIRT);
    await user.click(group("Category").getByRole("radio", { name: "Bottom" }));
    await user.click(group("Category").getByRole("radio", { name: "Top" }));
    await user.click(group("Type").getByRole("radio", { name: "Shirt" }));
    await save();
    expect(onSubmit).toHaveBeenCalledWith(SHIRT, false);
  });

  it("true when the main colour changes, even with the same set of colours", async () => {
    const { user, save, onSubmit } = renderForm(SHIRT);
    await user.click(group("Colours").getByRole("checkbox", { name: /Navy/ }));
    await user.click(group("Colours").getByRole("checkbox", { name: /Navy/ }));
    await save();
    expect(onSubmit).toHaveBeenCalledWith({ ...SHIRT, colours: ["white", "navy"] }, true);
  });

  it("true when the fabric is cleared", async () => {
    const { user, save, onSubmit } = renderForm(SHIRT);
    await user.clear(screen.getByLabelText(/Fabric/));
    await save();
    expect(onSubmit).toHaveBeenCalledWith(NO_FABRIC, true);
  });

  it("true when only the formality changes", async () => {
    const { user, save, onSubmit } = renderForm(SHIRT);
    await user.click(group("Formality").getByRole("radio", { name: /^4/ }));
    await save();
    expect(onSubmit).toHaveBeenCalledWith({ ...SHIRT, formality: 4 }, true);
  });
});
