"use client";

import { cn } from "@/lib/utils";

export interface ChipOption<V extends string | number> {
  value: V;
  label: string;
  /** Optional colour swatch shown before the label. */
  swatch?: string;
  /** Optional small note after the label, e.g. "Main". */
  note?: string;
}

interface BaseProps<V extends string | number> {
  /** Shared `name` for the inputs in this group. */
  name: string;
  options: ChipOption<V>[];
  disabled?: boolean;
  invalid?: boolean;
  /** id of an element describing an error, for aria-describedby. */
  describedBy?: string;
}

interface SingleProps<V extends string | number> extends BaseProps<V> {
  multiple?: false;
  value: V | null;
  onChange: (value: V) => void;
}

interface MultipleProps<V extends string | number> extends BaseProps<V> {
  multiple: true;
  value: readonly V[];
  onChange: (value: V) => void;
  /** Once this many are chosen, the rest are disabled. */
  max?: number;
}

/**
 * A wrapping row of tappable chips backed by real radio buttons (single
 * choice) or checkboxes (multiple). Native inputs keep keyboard and screen
 * reader behaviour for free; each chip is at least 44 px tall.
 */
export function ChoiceChips<V extends string | number>(props: SingleProps<V> | MultipleProps<V>) {
  const { name, options, disabled, invalid, describedBy } = props;
  const isChecked = (value: V) => (props.multiple ? props.value.includes(value) : props.value === value);
  const atMax = props.multiple && props.max !== undefined && props.value.length >= props.max;

  return (
    <div className="flex flex-wrap gap-2">
      {options.map((option) => {
        const checked = isChecked(option.value);
        const optionDisabled = disabled || (atMax && !checked);
        return (
          <label
            key={String(option.value)}
            className={cn(
              "inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-full border px-4 text-sm font-medium transition-colors select-none",
              "has-[:focus-visible]:ring-ring/50 has-[:focus-visible]:ring-[3px]",
              checked ? "border-primary bg-primary text-primary-foreground" : "bg-background hover:bg-accent",
              optionDisabled && "cursor-not-allowed opacity-50",
              invalid && !checked && "border-destructive/60",
            )}
          >
            <input
              type={props.multiple ? "checkbox" : "radio"}
              name={name}
              value={String(option.value)}
              checked={checked}
              disabled={optionDisabled}
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              onChange={() => props.onChange(option.value)}
              className="sr-only"
            />
            {option.swatch && (
              <span
                aria-hidden="true"
                className="size-4 shrink-0 rounded-full border border-black/15"
                style={{ backgroundColor: option.swatch }}
              />
            )}
            <span>{option.label}</span>
            {option.note && <span className="text-xs font-normal opacity-80">({option.note})</span>}
          </label>
        );
      })}
    </div>
  );
}
