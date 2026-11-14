import {
  BUILDS_BY_GENDER,
  MODEL_PRESET_IMAGES_ARE_PLACEHOLDERS,
  MODEL_PRESETS,
  MODEL_PRESETS_BY_ID,
  SKIN_TONES,
  type ModelBuild,
  type ModelGender,
  type ModelPreset,
  type SkinTone,
} from "@/contracts";

/**
 * Display helpers for the model preset grid (settings and the outfit
 * screen's "Pick your model" sheet). The presets themselves, their full
 * labels and image paths come from the contract (src/contracts/previews.ts).
 *
 * The preset pictures in public/presets are placeholder silhouettes until
 * the real set is generated (MODEL_PRESET_IMAGES_ARE_PLACEHOLDERS, PROGRESS.md
 * P5). The grid shows whatever is there and doesn't mention it; the flag is
 * re-exported here so it's visible next to the code that shows the pictures.
 */
export const PRESET_IMAGES_ARE_PLACEHOLDERS = MODEL_PRESET_IMAGES_ARE_PLACEHOLDERS;

/** The figure switch's labels. */
export const GENDER_TAB_LABELS: Record<ModelGender, string> = { women: "Women's figures", men: "Men's figures" };

/** Row headings: one per build. Plain descriptive words, nothing evaluative. */
export const BUILD_HEADINGS: Record<ModelBuild, string> = {
  slim: "Slim build",
  average: "Average build",
  curvy: "Curvy build",
  broad: "Broad build",
  plus: "Plus size",
};

/** Caption under each picture: its skin tone. */
export const TONE_CAPTIONS: Record<SkinTone, string> = { light: "Light skin", medium: "Medium skin", deep: "Deep skin" };

/** The preset for an ID, or null (null, unknown or a retired ID). */
export function findPreset(id: string | null | undefined): ModelPreset | null {
  return (id && MODEL_PRESETS_BY_ID.get(id)) || null;
}

/** The figure a preset belongs to, so the grid opens on the right tab; women's when none is picked. */
export function genderOf(id: string | null | undefined): ModelGender {
  return findPreset(id)?.gender ?? "women";
}

/** One figure's presets as grid rows: a row per build (in the contract's order), a column per skin tone. */
export function presetRows(gender: ModelGender): { build: ModelBuild; presets: ModelPreset[] }[] {
  return BUILDS_BY_GENDER[gender].map((build) => ({
    build,
    presets: SKIN_TONES.map((tone) => {
      const preset = MODEL_PRESETS.find((p) => p.gender === gender && p.build === build && p.skinTone === tone);
      if (!preset) throw new Error(`No model preset for ${gender} ${build} ${tone}`);
      return preset;
    }),
  }));
}
