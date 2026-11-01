"use client";

import { useId } from "react";
import Link from "next/link";
import { SparklesIcon, StoreIcon, XIcon } from "lucide-react";
import {
  CUSTOM_STYLE_MAX_LENGTH,
  GUIDANCE_MAX_LENGTH,
  OUTFIT_COUNT,
  PRESET_STYLES,
  type WardrobeItem,
} from "@/contracts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { ApiFailure } from "./api";
import { subcategoryLabel } from "./copy";
import { STICKY_ACTION_STYLE } from "./layout";
import { ItemThumbnail } from "./outfit-card";
import type { DraftField, RequestDraft } from "./request-draft";
import { ApiErrorNotice } from "./result-notices";

export type AnchorState =
  | { status: "none" }
  | { status: "loading"; id: string }
  | { status: "ready"; item: WardrobeItem }
  /** The item was deleted (404): outfits use the whole wardrobe. */
  | { status: "missing" }
  /** Couldn't load it for another reason (offline, server error): retry or go without. */
  | { status: "error"; id: string; error: ApiFailure };

interface RequestFormProps {
  draft: RequestDraft;
  onDraftChange: (draft: RequestDraft) => void;
  anchor: AnchorState;
  onRemoveAnchor: () => void;
  onRetryAnchor: () => void;
  error: { field: DraftField; message: string } | null;
  submitting: boolean;
  onSubmit: () => void;
}

const COUNTS = Array.from({ length: OUTFIT_COUNT.max - OUTFIT_COUNT.min + 1 }, (_, i) => OUTFIT_COUNT.min + i);

/** The style chips, custom style, guidance and count. */
export function RequestForm(props: RequestFormProps) {
  const { draft, onDraftChange } = props;
  const ids = {
    guidance: useId(),
    custom: useId(),
    styleError: useId(),
    customError: useId(),
    guidanceError: useId(),
    guidanceCount: useId(),
    countError: useId(),
    shopItems: useId(),
    shopItemsHint: useId(),
  };
  const update = (patch: Partial<RequestDraft>) => onDraftChange({ ...draft, ...patch });
  const fieldError = (field: DraftField) => (props.error?.field === field ? props.error.message : null);
  const anchorBlocks = props.anchor.status === "loading" || props.anchor.status === "error";

  return (
    <form
      noValidate
      className="space-y-6"
      onSubmit={(e) => {
        e.preventDefault();
        props.onSubmit();
      }}
    >
      <AnchorCard anchor={props.anchor} onRemove={props.onRemoveAnchor} onRetry={props.onRetryAnchor} />

      <fieldset className="space-y-3" aria-describedby={fieldError("style") ? ids.styleError : undefined}>
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
          <p id={ids.styleError} className="text-destructive text-sm" role="alert">
            {fieldError("style")}
          </p>
        )}
        {draft.style === "custom" && (
          <div className="space-y-2">
            <Label htmlFor={ids.custom}>Describe the occasion</Label>
            <Input
              id={ids.custom}
              value={draft.customText}
              onChange={(e) => update({ customText: e.target.value })}
              maxLength={CUSTOM_STYLE_MAX_LENGTH}
              placeholder="e.g. first day at a new job"
              aria-invalid={fieldError("customText") ? true : undefined}
              aria-describedby={fieldError("customText") ? ids.customError : undefined}
              autoFocus
            />
            {fieldError("customText") && (
              <p id={ids.customError} className="text-destructive text-sm" role="alert">
                {fieldError("customText")}
              </p>
            )}
          </div>
        )}
      </fieldset>

      <div className="space-y-2">
        <Label htmlFor={ids.guidance}>
          Anything else? <span className="text-muted-foreground font-normal">(optional)</span>
        </Label>
        <Textarea
          id={ids.guidance}
          value={draft.guidance}
          onChange={(e) => update({ guidance: e.target.value })}
          maxLength={GUIDANCE_MAX_LENGTH}
          rows={2}
          placeholder="e.g. no heels, or use my green dress"
          aria-invalid={fieldError("guidance") ? true : undefined}
          aria-describedby={fieldError("guidance") ? ids.guidanceError : undefined}
        />
        <p id={ids.guidanceCount} className="text-muted-foreground text-right text-xs" aria-hidden>
          {draft.guidance.length}/{GUIDANCE_MAX_LENGTH}
        </p>
        {fieldError("guidance") && (
          <p id={ids.guidanceError} className="text-destructive text-sm" role="alert">
            {fieldError("guidance")}
          </p>
        )}
      </div>

      <fieldset className="space-y-2" aria-describedby={fieldError("count") ? ids.countError : undefined}>
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
        {fieldError("count") && (
          <p id={ids.countError} className="text-destructive text-sm" role="alert">
            {fieldError("count")}
          </p>
        )}
      </fieldset>

      <div className="space-y-2 rounded-lg border p-3" data-testid="include-shop-items">
        <label htmlFor={ids.shopItems} className="flex min-h-11 cursor-pointer items-center gap-3">
          <StoreIcon aria-hidden className="text-muted-foreground size-5 shrink-0" />
          <span className="flex-1 text-sm font-medium">Include items from my shops</span>
          <input
            id={ids.shopItems}
            type="checkbox"
            role="switch"
            checked={draft.includeShopItems}
            onChange={(e) => update({ includeShopItems: e.target.checked })}
            aria-describedby={ids.shopItemsHint}
            className="accent-primary size-6 shrink-0 cursor-pointer"
          />
        </label>
        <p id={ids.shopItemsHint} className="text-muted-foreground text-xs leading-snug">
          Each outfit may suggest one new piece to buy, even if you own something similar. You can then find it in your
          favourite shops.
        </p>
        <Link href="/settings" className="inline-flex min-h-11 items-center text-sm underline underline-offset-4">
          Choose your shops
        </Link>
      </div>

      {/* Thumb-reachable: the main action sticks to the bottom of the screen. */}
      <div className="bg-background/95 sticky -mx-4 border-t px-4 pt-3 pb-3 backdrop-blur" style={STICKY_ACTION_STYLE}>
        <Button type="submit" size="lg" className="w-full" disabled={props.submitting || anchorBlocks}>
          <SparklesIcon aria-hidden />
          {props.submitting ? "Finding outfits…" : "Get outfits"}
        </Button>
      </div>
    </form>
  );
}

/**
 * A preset (or "Something else") as a radio chip. The name is just the
 * label; the "covers" hint is its description, so screen readers read both
 * without the hint becoming part of the name.
 */
function StyleChip(props: { label: string; hint: string; checked: boolean; onSelect: () => void }) {
  const labelId = useId();
  const hintId = useId();
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
        aria-labelledby={labelId}
        aria-describedby={hintId}
      />
      <span id={labelId} className="text-sm font-medium">
        {props.label}
      </span>
      <span
        id={hintId}
        className={cn("text-xs leading-snug", props.checked ? "text-primary-foreground/80" : "text-muted-foreground")}
      >
        {props.hint}
      </span>
    </label>
  );
}

function AnchorCard(props: { anchor: AnchorState; onRemove: () => void; onRetry: () => void }) {
  const { anchor } = props;
  if (anchor.status === "none") return null;

  if (anchor.status === "loading") {
    return (
      <div className="flex items-center gap-3 rounded-lg border p-3" aria-busy="true" aria-label="Loading your item">
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

  if (anchor.status === "error") {
    return (
      <section aria-label="Building around" data-testid="anchor-error" className="space-y-2">
        <ApiErrorNotice error={anchor.error} onRetry={props.onRetry} />
        <p className="text-muted-foreground text-sm">Couldn&apos;t load the item you picked to build around.</p>
        <Button type="button" variant="outline" className="w-full" onClick={props.onRemove}>
          Continue without it
        </Button>
      </section>
    );
  }

  const { item } = anchor;
  return (
    <section aria-label="Building around" data-testid="anchor-item" className="flex items-center gap-3 rounded-lg border p-3">
      <ItemThumbnail item={item} className="size-16" />
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
