/**
 * Friendly labels for the tag vocabularies in src/contracts. The contracts
 * use lower-case IDs ("t_shirt"); the UI shows these.
 */
import {
  CATEGORIES,
  COLOURS,
  PATTERNS,
  PRESET_STYLES,
  SEASONS,
  SUBCATEGORIES,
  WARMTH_LEVELS,
  type Category,
  type Colour,
  type Pattern,
  type PresetStyleId,
  type Season,
  type Subcategory,
  type Warmth,
} from "@/contracts";

export const CATEGORY_LABELS: Record<Category, string> = {
  top: "Top",
  bottom: "Bottom",
  dress_jumpsuit: "Dress or jumpsuit",
  outerwear: "Outerwear",
  shoes: "Shoes",
};

export const SUBCATEGORY_LABELS: Record<Subcategory, string> = {
  t_shirt: "T-shirt",
  shirt: "Shirt",
  blouse: "Blouse",
  polo: "Polo",
  jumper: "Jumper",
  jeans: "Jeans",
  trousers: "Trousers",
  chinos: "Chinos",
  skirt: "Skirt",
  shorts: "Shorts",
  dress: "Dress",
  jumpsuit: "Jumpsuit",
  jacket: "Jacket",
  blazer: "Blazer",
  coat: "Coat",
  trainers: "Trainers",
  boots: "Boots",
  sandals: "Sandals",
  heels: "Heels",
  flats: "Flats",
  loafers: "Loafers",
  smart_shoes: "Smart shoes",
};

export const COLOUR_LABELS: Record<Colour, string> = {
  black: "Black",
  white: "White",
  cream: "Cream",
  beige: "Beige",
  tan: "Tan",
  brown: "Brown",
  grey: "Grey",
  navy: "Navy",
  blue: "Blue",
  light_blue: "Light blue",
  teal: "Teal",
  green: "Green",
  olive: "Olive",
  yellow: "Yellow",
  orange: "Orange",
  red: "Red",
  burgundy: "Burgundy",
  pink: "Pink",
  purple: "Purple",
  gold: "Gold",
  silver: "Silver",
};

/** Swatch colours for the colour chips. Approximate; for recognition only. */
export const COLOUR_SWATCHES: Record<Colour, string> = {
  black: "#171717",
  white: "#ffffff",
  cream: "#f5efdc",
  beige: "#d9c7a7",
  tan: "#c19a6b",
  brown: "#6f4a2f",
  grey: "#8a8a8a",
  navy: "#1f2a4d",
  blue: "#2f5fb3",
  light_blue: "#9cc3e6",
  teal: "#1f7a7a",
  green: "#2f7d3a",
  olive: "#6b6b2f",
  yellow: "#f2cf3a",
  orange: "#e9802f",
  red: "#c62f2f",
  burgundy: "#7a1f35",
  pink: "#f0a6c0",
  purple: "#6d3fa0",
  gold: "#c9a227",
  silver: "#c0c0c0",
};

export const PATTERN_LABELS: Record<Pattern, string> = {
  plain: "Plain",
  stripe: "Stripe",
  floral: "Floral",
  check: "Check",
  print: "Print",
};

export const SEASON_LABELS: Record<Season, string> = {
  spring: "Spring",
  summer: "Summer",
  autumn: "Autumn",
  winter: "Winter",
};

export const WARMTH_LABELS: Record<Warmth, string> = {
  light: "Light",
  medium: "Medium",
  warm: "Warm",
};

/** 1 = loungewear … 5 = formal (spec: Tags per item). */
export const FORMALITY_LABELS: Record<1 | 2 | 3 | 4 | 5, string> = {
  1: "Lounge",
  2: "Casual",
  3: "Smart casual",
  4: "Smart",
  5: "Formal",
};

export const OCCASION_LABELS: Record<PresetStyleId, string> = Object.fromEntries(
  PRESET_STYLES.map((style) => [style.id, style.label]),
) as Record<PresetStyleId, string>;

export interface Option<V extends string | number> {
  value: V;
  label: string;
}

export const CATEGORY_OPTIONS: Option<Category>[] = CATEGORIES.map((value) => ({ value, label: CATEGORY_LABELS[value] }));
export const COLOUR_OPTIONS: Option<Colour>[] = COLOURS.map((value) => ({ value, label: COLOUR_LABELS[value] }));
export const PATTERN_OPTIONS: Option<Pattern>[] = PATTERNS.map((value) => ({ value, label: PATTERN_LABELS[value] }));
export const SEASON_OPTIONS: Option<Season>[] = SEASONS.map((value) => ({ value, label: SEASON_LABELS[value] }));
export const WARMTH_OPTIONS: Option<Warmth>[] = WARMTH_LEVELS.map((value) => ({ value, label: WARMTH_LABELS[value] }));
export const OCCASION_OPTIONS: Option<PresetStyleId>[] = PRESET_STYLES.map((style) => ({ value: style.id, label: style.label }));
export const FORMALITY_OPTIONS: Option<number>[] = ([1, 2, 3, 4, 5] as const).map((value) => ({
  value,
  label: `${value} · ${FORMALITY_LABELS[value]}`,
}));

export function subcategoryOptions(category: Category): Option<Subcategory>[] {
  return SUBCATEGORIES[category].map((value) => ({ value, label: SUBCATEGORY_LABELS[value] }));
}

/** "Mid-blue jeans" style summary line, e.g. "Bottom · Jeans". */
export function categoryLine(tags: { category: Category; subcategory: Subcategory }): string {
  return `${CATEGORY_LABELS[tags.category]} · ${SUBCATEGORY_LABELS[tags.subcategory]}`;
}
