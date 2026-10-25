"use client";

import { useId, useRef, useState } from "react";
import {
  DESCRIPTION_MAX_LENGTH,
  FABRIC_MAX_LENGTH,
  MAX_COLOURS,
  type Colour,
  type ItemTags,
  type PresetStyleId,
  type Season,
} from "@/contracts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ChoiceChips } from "./choice-chips";
import { StickyActions } from "./sticky-actions";
import {
  CATEGORY_OPTIONS,
  COLOUR_OPTIONS,
  COLOUR_SWATCHES,
  FORMALITY_OPTIONS,
  OCCASION_OPTIONS,
  PATTERN_OPTIONS,
  SEASON_OPTIONS,
  WARMTH_OPTIONS,
  subcategoryOptions,
} from "./labels";
import {
  TAG_FIELD_ORDER,
  parseTagValues,
  tagsWereEdited,
  toggleColour,
  toggleValue,
  valuesFromTags,
  withCategory,
  type TagField,
  type TagFormErrors,
  type TagFormValues,
} from "./tag-form-values";

export interface TagFormProps {
  /** Pre-filled tags, or null when tagging failed and the user fills them in. */
  initialTags: ItemTags | null;
  submitLabel: string;
  busyLabel?: string;
  busy?: boolean;
  /** `edited` is true if any tag differs from initialTags (always true when they were null). */
  onSubmit: (tags: ItemTags, edited: boolean) => void;
  onCancel?: () => void;
  cancelLabel?: string;
}

/**
 * Every tag from CONTRACTS.md section 3, all editable, validated with the
 * shared ItemTagsSchema on submit. Used to review a new item's suggested
 * tags and to edit a saved item's tags.
 */
export function TagForm({ initialTags, submitLabel, busyLabel, busy = false, onSubmit, onCancel, cancelLabel = "Cancel" }: TagFormProps) {
  const [values, setValues] = useState<TagFormValues>(() => valuesFromTags(initialTags));
  const [errors, setErrors] = useState<TagFormErrors>({});
  const [submitted, setSubmitted] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const idBase = useId();
  const errorId = (field: TagField) => `${idBase}-${field}-error`;

  function update(next: TagFormValues) {
    setValues(next);
    // Once they've tried to save, keep the messages in step with their fixes.
    if (submitted) {
      const result = parseTagValues(next);
      setErrors(result.ok ? {} : result.errors);
    }
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitted(true);
    const result = parseTagValues(values);
    if (!result.ok) {
      setErrors(result.errors);
      const first = TAG_FIELD_ORDER.find((field) => result.errors[field]);
      const target = first && formRef.current?.querySelector<HTMLElement>(`[data-field="${first}"] input:not(:disabled)`);
      target?.focus();
      target?.scrollIntoView({ block: "center", behavior: "smooth" });
      return;
    }
    setErrors({});
    onSubmit(result.tags, tagsWereEdited(initialTags, result.tags));
  }

  const errorCount = Object.keys(errors).length;
  const subOptions = values.category ? subcategoryOptions(values.category) : [];

  return (
    <form ref={formRef} onSubmit={handleSubmit} noValidate aria-label="Item tags" className="space-y-6">
      {errorCount > 0 && (
        <Alert variant="destructive">
          <AlertTitle>Some tags need a look</AlertTitle>
          <AlertDescription>
            {errorCount === 1 ? "1 thing to fix before saving." : `${errorCount} things to fix before saving.`}
          </AlertDescription>
        </Alert>
      )}

      <ChipField field="category" legend="Category" error={errors.category} errorId={errorId("category")}>
        <ChoiceChips
          name={`${idBase}-category`}
          options={CATEGORY_OPTIONS}
          value={values.category || null}
          onChange={(category) => update(withCategory(values, category))}
          invalid={!!errors.category}
          describedBy={errors.category ? errorId("category") : undefined}
        />
      </ChipField>

      <ChipField field="subcategory" legend="Type" error={errors.subcategory} errorId={errorId("subcategory")}>
        {values.category ? (
          <ChoiceChips
            name={`${idBase}-subcategory`}
            options={subOptions}
            value={values.subcategory || null}
            onChange={(subcategory) => update({ ...values, subcategory })}
            invalid={!!errors.subcategory}
            describedBy={errors.subcategory ? errorId("subcategory") : undefined}
          />
        ) : (
          <p className="text-muted-foreground text-sm">Choose a category first.</p>
        )}
      </ChipField>

      <ChipField
        field="colours"
        legend="Colours"
        hint={`Up to ${MAX_COLOURS}. The first you pick is the main colour.`}
        error={errors.colours}
        errorId={errorId("colours")}
      >
        <ChoiceChips<Colour>
          multiple
          max={MAX_COLOURS}
          name={`${idBase}-colours`}
          options={COLOUR_OPTIONS.map((option) => ({
            ...option,
            swatch: COLOUR_SWATCHES[option.value],
            note: values.colours[0] === option.value && values.colours.length > 1 ? "main" : undefined,
          }))}
          value={values.colours}
          onChange={(colour) => update({ ...values, colours: toggleColour(values.colours, colour) })}
          invalid={!!errors.colours}
          describedBy={errors.colours ? errorId("colours") : undefined}
        />
      </ChipField>

      <ChipField field="pattern" legend="Pattern" error={errors.pattern} errorId={errorId("pattern")}>
        <ChoiceChips
          name={`${idBase}-pattern`}
          options={PATTERN_OPTIONS}
          value={values.pattern || null}
          onChange={(pattern) => update({ ...values, pattern })}
          invalid={!!errors.pattern}
          describedBy={errors.pattern ? errorId("pattern") : undefined}
        />
      </ChipField>

      <ChipField
        field="formality"
        legend="Formality"
        hint="1 is loungewear, 5 is formal."
        error={errors.formality}
        errorId={errorId("formality")}
      >
        <ChoiceChips
          name={`${idBase}-formality`}
          options={FORMALITY_OPTIONS}
          value={values.formality}
          onChange={(formality) => update({ ...values, formality })}
          invalid={!!errors.formality}
          describedBy={errors.formality ? errorId("formality") : undefined}
        />
      </ChipField>

      <ChipField field="seasons" legend="Seasons" hint="All four means all year." error={errors.seasons} errorId={errorId("seasons")}>
        <ChoiceChips<Season>
          multiple
          name={`${idBase}-seasons`}
          options={SEASON_OPTIONS}
          value={values.seasons}
          onChange={(season) => update({ ...values, seasons: toggleValue(values.seasons, season) })}
          invalid={!!errors.seasons}
          describedBy={errors.seasons ? errorId("seasons") : undefined}
        />
      </ChipField>

      <ChipField field="warmth" legend="Warmth" error={errors.warmth} errorId={errorId("warmth")}>
        <ChoiceChips
          name={`${idBase}-warmth`}
          options={WARMTH_OPTIONS}
          value={values.warmth || null}
          onChange={(warmth) => update({ ...values, warmth })}
          invalid={!!errors.warmth}
          describedBy={errors.warmth ? errorId("warmth") : undefined}
        />
      </ChipField>

      <ChipField field="occasions" legend="Occasions" hint="Every style it suits." error={errors.occasions} errorId={errorId("occasions")}>
        <ChoiceChips<PresetStyleId>
          multiple
          name={`${idBase}-occasions`}
          options={OCCASION_OPTIONS}
          value={values.occasions}
          onChange={(occasion) => update({ ...values, occasions: toggleValue(values.occasions, occasion) })}
          invalid={!!errors.occasions}
          describedBy={errors.occasions ? errorId("occasions") : undefined}
        />
      </ChipField>

      <div className="space-y-2" data-field="fabric">
        <Label htmlFor={`${idBase}-fabric`}>
          Fabric <span className="text-muted-foreground font-normal">(optional)</span>
        </Label>
        <Input
          id={`${idBase}-fabric`}
          value={values.fabric}
          maxLength={FABRIC_MAX_LENGTH}
          autoCapitalize="none"
          placeholder="e.g. denim"
          onChange={(event) => update({ ...values, fabric: event.target.value })}
          aria-invalid={!!errors.fabric || undefined}
          aria-describedby={errors.fabric ? errorId("fabric") : undefined}
        />
        <FieldError id={errorId("fabric")} message={errors.fabric} />
      </div>

      <div className="space-y-2" data-field="description">
        <Label htmlFor={`${idBase}-description`}>Description</Label>
        <Input
          id={`${idBase}-description`}
          value={values.description}
          maxLength={DESCRIPTION_MAX_LENGTH}
          placeholder="e.g. Navy slim-fit chinos"
          onChange={(event) => update({ ...values, description: event.target.value })}
          aria-invalid={!!errors.description || undefined}
          aria-describedby={`${idBase}-description-count${errors.description ? ` ${errorId("description")}` : ""}`}
        />
        <p id={`${idBase}-description-count`} className="text-muted-foreground text-xs">
          One line, used when you search your wardrobe. {values.description.length}/{DESCRIPTION_MAX_LENGTH}
        </p>
        <FieldError id={errorId("description")} message={errors.description} />
      </div>

      <StickyActions>
        {onCancel && (
          <Button type="button" variant="outline" className="flex-1" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
        )}
        <Button type="submit" className="flex-[2]" disabled={busy}>
          {busy ? (busyLabel ?? "Saving…") : submitLabel}
        </Button>
      </StickyActions>
    </form>
  );
}

function ChipField({
  field,
  legend,
  hint,
  error,
  errorId,
  children,
}: {
  field: TagField;
  legend: string;
  hint?: string;
  error?: string;
  errorId: string;
  children: React.ReactNode;
}) {
  return (
    <fieldset className="space-y-2" data-field={field}>
      <legend className="mb-2 text-sm font-medium">{legend}</legend>
      {hint && <p className="text-muted-foreground -mt-1 text-xs">{hint}</p>}
      {children}
      <FieldError id={errorId} message={error} />
    </fieldset>
  );
}

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} className="text-destructive text-sm">
      {message}
    </p>
  );
}
