import { z } from "zod";
import { singleLineText } from "./common";

/**
 * The nine preset styles from the spec, each with its formality band (1–5).
 * The same IDs are used for an item's `occasions` tag.
 */
export const PRESET_STYLE_IDS = [
  "comfy",
  "active",
  "casual",
  "holiday",
  "smart_casual",
  "work",
  "evening_out",
  "wedding_guest",
  "formal_event",
] as const;
export const PresetStyleIdSchema = z.enum(PRESET_STYLE_IDS);
export type PresetStyleId = z.infer<typeof PresetStyleIdSchema>;

export interface FormalityBand {
  min: number;
  max: number;
}

export interface PresetStyle {
  id: PresetStyleId;
  label: string;
  formality: FormalityBand;
  covers: string;
}

/** Spec table "Outfit suggestions → Request". Order is the display order. */
export const PRESET_STYLES: readonly PresetStyle[] = [
  { id: "comfy", label: "Comfy", formality: { min: 1, max: 1 }, covers: "At home, lounging, low-key errands" },
  { id: "active", label: "Active", formality: { min: 1, max: 2 }, covers: "Gym, walks, outdoor days" },
  { id: "casual", label: "Casual", formality: { min: 1, max: 2 }, covers: "Everyday, weekends, coffee with friends" },
  { id: "holiday", label: "Holiday", formality: { min: 1, max: 3 }, covers: "Beach, city breaks, warm-weather days out" },
  { id: "smart_casual", label: "Smart casual", formality: { min: 2, max: 3 }, covers: "Lunch out, meeting friends, relaxed offices" },
  { id: "work", label: "Work", formality: { min: 3, max: 4 }, covers: "Office, meetings, interviews" },
  { id: "evening_out", label: "Evening out", formality: { min: 3, max: 4 }, covers: "Dinner, drinks, date night, theatre" },
  { id: "wedding_guest", label: "Wedding guest", formality: { min: 4, max: 4 }, covers: "Daytime and evening weddings, christenings" },
  { id: "formal_event", label: "Formal event", formality: { min: 4, max: 5 }, covers: "Races, black tie, galas, awards" },
];

export const PRESET_STYLES_BY_ID: Readonly<Record<PresetStyleId, PresetStyle>> =
  Object.fromEntries(PRESET_STYLES.map((s) => [s.id, s])) as Record<PresetStyleId, PresetStyle>;

export const CUSTOM_STYLE_MAX_LENGTH = 100;

/**
 * What the user asked to dress for: a preset chip, or their own words
 * ("first day at a new job"). A custom style has no fixed formality band;
 * the outfit engine works one out.
 */
export const StyleChoiceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("preset"), presetId: PresetStyleIdSchema }),
  z.object({ kind: z.literal("custom"), text: singleLineText(CUSTOM_STYLE_MAX_LENGTH) }),
]);
export type StyleChoice = z.infer<typeof StyleChoiceSchema>;
