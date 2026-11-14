"use client";

import { CheckIcon } from "lucide-react";
import { useId, useState } from "react";
import { MODEL_GENDERS, type ModelGender, type ModelPresetId } from "@/contracts";
import { cn } from "@/lib/utils";
import { BUILD_HEADINGS, GENDER_TAB_LABELS, PRESET_IMAGES_ARE_PLACEHOLDERS, TONE_CAPTIONS, genderOf, presetRows } from "./presets";

export interface ModelPresetGridProps {
  /** The selected preset ID, or null when none is picked yet. */
  value: string | null;
  /** Called with the tapped preset. The grid doesn't save anything. */
  onChange: (id: ModelPresetId) => void;
  /**
   * The figure shown (women's or men's). Optional: by default the grid
   * keeps it itself, starting on the figure of `value` (women's if none).
   */
  gender?: ModelGender;
  onGenderChange?: (gender: ModelGender) => void;
  /** Greys the grid out, e.g. while saving. */
  disabled?: boolean;
  /** Name of the radio group, for screen readers. */
  label?: string;
  className?: string;
}

/**
 * The model preset picker: first women's or men's figures, then that
 * figure's builds (rows) × skin tones (columns). Shared by settings and the
 * outfit screen's "Pick your model" sheet.
 *
 * Both choices are native radio groups (arrow keys move between options;
 * each preset's accessible name is its full contract label, e.g. "Women's,
 * average build, medium skin tone"). Every option is at least 44 px.
 *
 *   <ModelPresetGrid value={presetId} onChange={setPresetId} />
 */
export function ModelPresetGrid({ value, onChange, gender, onGenderChange, disabled = false, label = "Model", className }: ModelPresetGridProps) {
  const [ownGender, setOwnGender] = useState<ModelGender>(() => genderOf(value));
  const shown = gender ?? ownGender;
  const name = useId();

  function showGender(next: ModelGender) {
    setOwnGender(next);
    onGenderChange?.(next);
  }

  return (
    <div className={cn("space-y-4", className)}>
      <fieldset disabled={disabled}>
        <legend className="sr-only">Figure</legend>
        <div className="bg-muted grid grid-cols-2 gap-1 rounded-lg p-1">
          {MODEL_GENDERS.map((g) => (
            <label
              key={g}
              className={cn(
                "has-focus-visible:ring-ring/50 flex min-h-11 cursor-pointer items-center justify-center rounded-md px-3 text-sm has-focus-visible:ring-[3px] has-disabled:cursor-default has-disabled:opacity-50",
                shown === g ? "bg-background font-medium shadow-xs" : "text-muted-foreground",
              )}
            >
              <input type="radio" className="sr-only" name={`${name}-figure`} value={g} checked={shown === g} onChange={() => showGender(g)} />
              {GENDER_TAB_LABELS[g]}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset disabled={disabled} className="space-y-3" data-testid="model-preset-grid">
        <legend className="sr-only">
          {label}: {GENDER_TAB_LABELS[shown]}
        </legend>
        {presetRows(shown).map(({ build, presets }) => (
          <div key={build} className="space-y-1.5">
            <p className="text-muted-foreground text-sm font-medium" aria-hidden="true">
              {BUILD_HEADINGS[build]}
            </p>
            <div className="grid grid-cols-3 gap-2">
              {presets.map((preset) => {
                const on = value === preset.id;
                return (
                  <label
                    key={preset.id}
                    className={cn(
                      "has-focus-visible:ring-ring/50 relative flex min-h-11 cursor-pointer flex-col overflow-hidden rounded-lg border text-sm has-focus-visible:ring-[3px] has-disabled:cursor-default has-disabled:opacity-60",
                      on ? "border-primary ring-primary ring-2" : "border-border",
                    )}
                  >
                    <input
                      type="radio"
                      className="sr-only"
                      name={`${name}-preset`}
                      value={preset.id}
                      aria-label={preset.label}
                      checked={on}
                      onChange={() => onChange(preset.id as ModelPresetId)}
                    />
                    {/* A plain <img>: small static files from public/presets, already sized. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={preset.imagePath}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      data-placeholder={PRESET_IMAGES_ARE_PLACEHOLDERS || undefined}
                      className="bg-muted aspect-[2/3] w-full object-cover"
                    />
                    <span className={cn("flex min-h-8 items-center justify-center px-1 text-center", on && "font-medium")} aria-hidden="true">
                      {TONE_CAPTIONS[preset.skinTone]}
                    </span>
                    {on && (
                      <span
                        className="bg-primary text-primary-foreground absolute top-1.5 right-1.5 flex size-6 items-center justify-center rounded-full"
                        aria-hidden="true"
                      >
                        <CheckIcon className="size-4" />
                      </span>
                    )}
                  </label>
                );
              })}
            </div>
          </div>
        ))}
      </fieldset>
    </div>
  );
}
