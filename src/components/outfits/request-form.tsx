"use client";

import { useId } from "react";
import { SparklesIcon, XIcon } from "lucide-react";
import {
  CUSTOM_STYLE_MAX_LENGTH,
  GUIDANCE_MAX_LENGTH,
  OUTFIT_COUNT,
  PRESET_STYLES,
  displayImageUrl,
  type WardrobeItem,
} from "@/contracts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { subcategoryLabel } from "./copy";
import type { RequestDraft } from "./request-draft";
import { STICKY_ACTION_STYLE } from "./layout";

export type AnchorState =
  | { status: "none" }
  | { status: "loading"; id: string }
  | { status: "ready"; item: WardrobeItem }
  | { status: "missing" };

interface RequestFormProps {
  draft: RequestDraft;
  onDraftChange: (draft: RequestDraft) => void;
  anchor: AnchorState;
  onRemoveAnchor: () => void;
  error: { field: string; message: string } | null;
  submitting: boolean;
  onSubmit: () => void;
}

const COUNTS = Array.from({ length: OUTFIT_COUNT.max - OUTFIT_COUNT.min + 1 }, (_, i) => OUTFIT_COUNT.min + i);

/** The style chips, custom style, guidance and count. */
export function RequestForm(props: RequestFormProps) {
  const { draft, onDraftChange } = props;
  const guidanceId = useId();
  const customId = useId();
  const styleErrorId = useId();
  const update = (patch: Partial<RequestDraft>) => onDraftChange({ ...draft, ...patch });
  const fieldError = (field: string) => (props.error?.field === field ? props.error.message : null);

  return (
    <form
      noValidate
      className="space-y-6"
      onSubmit={(e) => {
        e.preventDefault();
        props.onSubmit();
      }}
    >
      <AnchorCard anchor={props.anchor} onRemove={props.onRemoveAnchor} />

      <fieldset className="space-y-3" aria-describedby={fieldError("style") ? styleErrorId : undefined}>
        <legend className="mb-3 text-base font-semibold">What are you dressing for?</legend>
        <div className="grid grid-cols-2 gap-2">
          {PRESET_STYLES.map((style) => (
            <StyleChip
              key={style.id}
              label={style.label}
              hint={style.covers}
              checked={draft.style === style.id}
              onSelect={() => update({ style: style.id })}
            />
          ))}
          <StyleChip
            label="Something else"
            hint="Describe it in your own words"
            checked={draft.style === "custom"}
            onSelect={() => update({ style: "custom" })}
          />
        </div>
        {fieldError("style") && (
          <p id={styleErrorId} className="text-destructive text-sm" role="alert">
            {fieldError("style")}
          </p>
        )}
        {draft.style === "custom" && (
          <div className="space-y-2">
            <Label htmlFor={customId}>Describe the occasion</Label>
            <Input
              id={customId}
              value={draft.customText}
              onChange={(e) => update({ customText: e.target.value })}
              maxLength={CUSTOM_STYLE_MAX_LENGTH}
              placeholder="e.g. first day at a new job"
              aria-invalid={fieldError("customText") ? true : undefined}
              autoFocus
            />
            {fieldError("customText") && (
              <p className="text-destructive text-sm" role="alert">
                {fieldError("customText")}
              </p>
            )}
          </div>
        )}
      </fieldset>

      <div className="space-y-2">
        <Label htmlFor={guidanceId}>
          Anything else? <span className="text-muted-foreground font-normal">(optional)</span>
        </Label>
        <Textarea
          id={guidanceId}
          value={draft.guidance}
          onChange={(e) => update({ guidance: e.target.value })}
          maxLength={GUIDANCE_MAX_LENGTH}
          rows={2}
          placeholder="e.g. no heels, or use my green dress"
          aria-invalid={fieldError("guidance") ? true : undefined}
        />
        <p className="text-muted-foreground text-right text-xs" aria-hidden>
          {draft.guidance.length}/{GUIDANCE_MAX_LENGTH}
        </p>
        {fieldError("guidance") && (
          <p className="text-destructive text-sm" role="alert">
            {fieldError("guidance")}
          </p>
        )}
      </div>

      <fieldset className="space-y-2">
        <legend className="mb-2 text-sm font-medium">How many ideas?</legend>
        <div className="flex gap-2">
          {COUNTS.map((n) => (
            <label
              key={n}
              className={cn(
                "has-focus-visible:ring-ring/50 flex h-11 flex-1 cursor-pointer items-center justify-center rounded-md border text-sm font-medium has-focus-visible:ring-[3px]",
                draft.count === n && "bg-primary text-primary-foreground border-primary",
              )}
            >
              <input
                type="radio"
                name="outfit-count"
                className="sr-only"
                value={n}
                checked={draft.count === n}
                onChange={() => update({ count: n })}
                aria-label={`${n} outfits`}
              />
              {n}
            </label>
          ))}
        </div>
      </fieldset>

      {/* Thumb-reachable: the main action sticks to the bottom of the screen. */}
      <div className="bg-background/95 sticky -mx-4 border-t px-4 pt-3 pb-3 backdrop-blur" style={STICKY_ACTION_STYLE}>
        <Button type="submit" size="lg" className="w-full" disabled={props.submitting || props.anchor.status === "loading"}>
          <SparklesIcon aria-hidden />
          {props.submitting ? "Finding outfits…" : "Get outfits"}
        </Button>
      </div>
    </form>
  );
}

function StyleChip(props: { label: string; hint: string; checked: boolean; onSelect: () => void }) {
  return (
    <label
      className={cn(
        "has-focus-visible:ring-ring/50 flex min-h-16 cursor-pointer flex-col justify-center gap-0.5 rounded-lg border px-3 py-2 transition-colors has-focus-visible:ring-[3px]",
        props.checked ? "bg-primary text-primary-foreground border-primary" : "hover:bg-accent",
      )}
    >
      <input
        type="radio"
        name="style"
        className="sr-only"
        checked={props.checked}
        onChange={props.onSelect}
        aria-label={props.label}
      />
      <span className="text-sm font-medium">{props.label}</span>
      <span className={cn("text-xs leading-snug", props.checked ? "text-primary-foreground/80" : "text-muted-foreground")}>
        {props.hint}
      </span>
    </label>
  );
}

function AnchorCard(props: { anchor: AnchorState; onRemove: () => void }) {
  const { anchor } = props;
  if (anchor.status === "none") return null;

  if (anchor.status === "loading") {
    return (
      <div className="flex items-center gap-3 rounded-lg border p-3" aria-busy="true">
        <Skeleton className="size-16" />
        <Skeleton className="h-4 flex-1" />
      </div>
    );
  }

  if (anchor.status === "missing") {
    return (
      <p className="text-muted-foreground rounded-lg border p-3 text-sm" role="status">
        That item isn&apos;t in your wardrobe any more, so outfits will use everything you have.
      </p>
    );
  }

  const { item } = anchor;
  return (
    <section aria-label="Building around" data-testid="anchor-item" className="flex items-center gap-3 rounded-lg border p-3">
      {/* eslint-disable-next-line @next/next/no-img-element -- signed URLs; see outfit-card.tsx */}
      <img src={displayImageUrl(item)} alt="" className="bg-muted size-16 shrink-0 rounded-md object-contain p-1" />
      <div className="min-w-0 flex-1">
        <p className="text-muted-foreground text-xs">Building outfits around</p>
        <p className="truncate font-medium">{item.tags.description}</p>
        <p className="text-muted-foreground text-xs">{subcategoryLabel(item.tags.subcategory)}</p>
      </div>
      <Button type="button" variant="ghost" size="icon" onClick={props.onRemove} aria-label="Don't build around this item">
        <XIcon aria-hidden />
      </Button>
    </section>
  );
}
