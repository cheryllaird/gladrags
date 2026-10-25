/**
 * The tag form's working state and its conversion to and from ItemTags.
 * Kept free of React so it can be unit-tested on its own.
 */
import {
  ItemTagsSchema,
  MAX_COLOURS,
  isSubcategoryOf,
  type Category,
  type Colour,
  type ItemTags,
  type Pattern,
  type PresetStyleId,
  type Season,
  type Warmth,
} from "@/contracts";

/** Every field may be blank while the user is filling the form in. */
export interface TagFormValues {
  category: Category | "";
  subcategory: string;
  /** In the order chosen: the first is the main colour. */
  colours: Colour[];
  pattern: Pattern | "";
  formality: number | null;
  seasons: Season[];
  warmth: Warmth | "";
  occasions: PresetStyleId[];
  fabric: string;
  description: string;
}

export type TagField = keyof TagFormValues;
export type TagFormErrors = Partial<Record<TagField, string>>;

export const EMPTY_TAG_VALUES: TagFormValues = {
  category: "",
  subcategory: "",
  colours: [],
  pattern: "",
  formality: null,
  seasons: [],
  warmth: "",
  occasions: [],
  fabric: "",
  description: "",
};

/** Suggested tags into form values; null (tagging failed) gives an empty form. */
export function valuesFromTags(tags: ItemTags | null): TagFormValues {
  if (!tags) return structuredClone(EMPTY_TAG_VALUES);
  return {
    category: tags.category,
    subcategory: tags.subcategory,
    colours: [...tags.colours],
    pattern: tags.pattern,
    formality: tags.formality,
    seasons: [...tags.seasons],
    warmth: tags.warmth,
    occasions: [...tags.occasions],
    fabric: tags.fabric ?? "",
    description: tags.description,
  };
}

/** Change the category, clearing the subcategory if it no longer fits. */
export function withCategory(values: TagFormValues, category: Category): TagFormValues {
  const subcategory = values.subcategory && isSubcategoryOf(category, values.subcategory) ? values.subcategory : "";
  return { ...values, category, subcategory };
}

/** Add or remove a value from a multi-select, keeping the order chosen and an optional limit. */
export function toggleValue<T>(list: readonly T[], value: T, max?: number): T[] {
  if (list.includes(value)) return list.filter((v) => v !== value);
  if (max !== undefined && list.length >= max) return [...list];
  return [...list, value];
}

export function toggleColour(colours: readonly Colour[], colour: Colour): Colour[] {
  return toggleValue(colours, colour, MAX_COLOURS);
}

const FIELD_MESSAGES: Record<TagField, string> = {
  category: "Choose a category",
  subcategory: "Choose a type",
  colours: "Choose at least one colour",
  pattern: "Choose a pattern",
  formality: "Choose how formal it is",
  seasons: "Choose at least one season",
  warmth: "Choose how warm it is",
  occasions: "Choose at least one occasion",
  fabric: "Keep the fabric to one short line",
  description: "Add a short description",
};

/**
 * Validate the form with the shared ItemTagsSchema. On failure, returns one
 * plain-English message per field, in form order.
 */
export function parseTagValues(
  values: TagFormValues,
): { ok: true; tags: ItemTags } | { ok: false; errors: TagFormErrors } {
  const result = ItemTagsSchema.safeParse({
    category: values.category || undefined,
    subcategory: values.subcategory || undefined,
    colours: values.colours,
    pattern: values.pattern || undefined,
    formality: values.formality ?? undefined,
    seasons: values.seasons,
    warmth: values.warmth || undefined,
    occasions: values.occasions,
    fabric: values.fabric,
    description: values.description,
  });
  if (result.success) return { ok: true, tags: result.data };

  const errors: TagFormErrors = {};
  for (const issue of result.error.issues) {
    const field = issue.path[0] as TagField | undefined;
    if (!field || errors[field]) continue;
    errors[field] = describeIssue(field, values, issue.message);
  }
  return { ok: false, errors };
}

function describeIssue(field: TagField, values: TagFormValues, schemaMessage: string): string {
  if (field === "description" && values.description.trim() !== "") {
    // Too long or multi-line: the schema's own message says which.
    return schemaMessage;
  }
  if (field === "subcategory" && values.subcategory !== "") return "Choose a type that matches the category";
  return FIELD_MESSAGES[field];
}

/** Order the fields appear in on the form, for focusing the first error. */
export const TAG_FIELD_ORDER: TagField[] = [
  "category",
  "subcategory",
  "colours",
  "pattern",
  "formality",
  "seasons",
  "warmth",
  "occasions",
  "fabric",
  "description",
];

function sameTags(a: ItemTags, b: ItemTags): boolean {
  return JSON.stringify(normalise(a)) === JSON.stringify(normalise(b));
}

function normalise(tags: ItemTags) {
  // Colour order matters (the first is the main colour); season and occasion order doesn't.
  return {
    ...tags,
    seasons: [...tags.seasons].sort(),
    occasions: [...tags.occasions].sort(),
  };
}

/**
 * Whether the user changed any suggested tag. Filling in tags after tagging
 * failed counts as edited (CreateItemRequest.tagsEdited).
 */
export function tagsWereEdited(suggested: ItemTags | null, saved: ItemTags): boolean {
  return suggested === null || !sameTags(suggested, saved);
}
