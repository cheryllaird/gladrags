"use client";

import { useId } from "react";
import {
  BUILDS_BY_GENDER,
  MODEL_GENDERS,
  MODEL_PRESETS,
  type ModelGender,
  type ModelPreset,
  type ModelPresetId,
} from "@/contracts";
import { cn } from "@/lib/utils";

/**
 * The model figure picker: the 24 presets (MODEL_PRESETS, docs/CONTRACTS.md
 * section 12) as two grids of radio buttons, women's then men's, one row
 * per build and one column per skin tone.
 *
 * Shared on purpose: the outfit screens' "Pick your model" sheet (outfit-ui)
 * and the settings screen's picker (wardrobe-ui) both use it, so the two
 * always look and behave the same. It only shows and reports the choice;
 * saving it (PUT /api/settings) is up to the screen.
 */
export interface ModelPresetGridProps {
  value: ModelPresetId;
  onChange: (id: ModelPresetId) => void;
  disabled?: boolean;
  className?: string;
}

const GENDER_HEADINGS: Record<ModelGender, string> = { women: "Women's figures", men: "Men's figures" };

/** Short caption under each picture: "Curvy, deep". The full label is what screen readers hear. */
export function presetCaption(preset: ModelPreset): string {
  const build = preset.build === "plus" ? "Plus size" : preset.build.charAt(0).toUpperCase() + preset.build.slice(1);
  return `${build}, ${preset.skinTone}`;
}

/** Presets for one figure, in grid order (build, then tone). */
export function presetsFor(gender: ModelGender): ModelPreset[] {
  const builds = BUILDS_BY_GENDER[gender];
  return MODEL_PRESETS.filter((p) => p.gender === gender).sort((a, b) => builds.indexOf(a.build) - builds.indexOf(b.build));
}

export function ModelPresetGrid({ value, onChange, disabled = false, className }: ModelPresetGridProps) {
  const name = useId();
  return (
    <div className={cn("space-y-5", className)} data-testid="model-preset-grid">
      {MODEL_GENDERS.map((gender) => (
        <fieldset key={gender} className="space-y-2" disabled={disabled}>
          <legend className="mb-2 text-sm font-medium">{GENDER_HEADINGS[gender]}</legend>
          <div className="grid grid-cols-3 gap-2">
            {presetsFor(gender).map((preset) => {
              const checked = preset.id === value;
              return (
                <label
                  key={preset.id}
                  className={cn(
                    "has-focus-visible:ring-ring/50 relative flex cursor-pointer flex-col items-center gap-1 rounded-lg border p-1 has-focus-visible:ring-[3px]",
                    checked ? "border-primary ring-primary ring-2" : "border-border",
                    disabled && "cursor-not-allowed opacity-60",
                  )}
                >
                  <input
                    type="radio"
                    name={name}
                    value={preset.id}
                    checked={checked}
                    onChange={() => onChange(preset.id as ModelPresetId)}
                    aria-label={preset.label}
                    className="sr-only"
                  />
                  {/* Small static pictures from public/presets; no optimiser needed. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={preset.imagePath}
                    alt=""
                    loading="lazy"
                    width={512}
                    height={768}
                    className="bg-muted aspect-[2/3] w-full rounded-md object-cover"
                  />
                  <span className="text-muted-foreground text-center text-xs leading-tight">{presetCaption(preset)}</span>
                </label>
              );
            })}
          </div>
        </fieldset>
      ))}
    </div>
  );
}
