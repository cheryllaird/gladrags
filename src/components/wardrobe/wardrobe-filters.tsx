"use client";

import { SearchIcon, XIcon } from "lucide-react";
import { useId } from "react";
import type { Category, Colour, PresetStyleId } from "@/contracts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { CATEGORY_OPTIONS, COLOUR_OPTIONS, OCCASION_OPTIONS } from "./labels";
import { NO_FILTERS, SEARCH_MAX_LENGTH, hasActiveFilters, type WardrobeFilters } from "./wardrobe-filter-values";

/**
 * Search on the description, plus category, colour and occasion filters
 * (spec: Wardrobe screen). Native selects, so phones use their own picker.
 */
export function WardrobeFiltersBar({
  value,
  onChange,
}: {
  value: WardrobeFilters;
  onChange: (next: WardrobeFilters) => void;
}) {
  const id = useId();

  return (
    <div className="space-y-2" role="search" aria-label="Filter your wardrobe">
      <div className="relative">
        <Label htmlFor={`${id}-q`} className="sr-only">
          Search descriptions
        </Label>
        <SearchIcon className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" aria-hidden="true" />
        <Input
          id={`${id}-q`}
          type="search"
          inputMode="search"
          enterKeyHint="search"
          placeholder="Search, e.g. linen"
          maxLength={SEARCH_MAX_LENGTH}
          value={value.q}
          onChange={(event) => onChange({ ...value, q: event.target.value })}
          className="pl-9"
        />
      </div>
      <div className="grid grid-cols-3 gap-2">
        <FilterSelect
          id={`${id}-category`}
          label="Category"
          value={value.category}
          options={CATEGORY_OPTIONS}
          onChange={(category) => onChange({ ...value, category: category as Category | "" })}
        />
        <FilterSelect
          id={`${id}-colour`}
          label="Colour"
          value={value.colour}
          options={COLOUR_OPTIONS}
          onChange={(colour) => onChange({ ...value, colour: colour as Colour | "" })}
        />
        <FilterSelect
          id={`${id}-occasion`}
          label="Occasion"
          value={value.occasion}
          options={OCCASION_OPTIONS}
          onChange={(occasion) => onChange({ ...value, occasion: occasion as PresetStyleId | "" })}
        />
      </div>
      {hasActiveFilters(value) && (
        <Button type="button" variant="ghost" size="sm" className="h-11 px-2" onClick={() => onChange(NO_FILTERS)}>
          <XIcon aria-hidden="true" />
          Clear filters
        </Button>
      )}
    </div>
  );
}

function FilterSelect({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <div className="min-w-0">
      <Label htmlFor={id} className="sr-only">
        {label}
      </Label>
      <NativeSelect
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        // Stays at 16px text (from NativeSelect) so iOS doesn't zoom in on focus.
        className={`pr-7 pl-2.5 ${value ? "border-primary font-medium" : "text-muted-foreground"}`}
      >
        <NativeSelectOption value="">{label}</NativeSelectOption>
        {options.map((option) => (
          <NativeSelectOption key={option.value} value={option.value}>
            {option.label}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </div>
  );
}
