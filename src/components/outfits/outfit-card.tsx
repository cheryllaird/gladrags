"use client";

import { useId, useState } from "react";
import { RefreshCwIcon, SlidersHorizontalIcon, Undo2Icon } from "lucide-react";
import {
  GUIDANCE_MAX_LENGTH,
  displayImageUrl,
  type Outfit,
  type OutfitStatus,
  type UpdateOutfitStatusRequest,
  type WardrobeItem,
} from "@/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { QUICK_REFINEMENTS, styleLabel, subcategoryLabel } from "./copy";
import { FeedbackBar } from "./feedback-bar";
import { OutfitCollage } from "./outfit-collage";

interface OutfitCardProps {
  outfit: Outfit;
  status: OutfitStatus;
  /** A status change for this outfit is in flight. */
  statusBusy: boolean;
  onStatusChange: (update: UpdateOutfitStatusRequest) => void;
  /**
   * "results": swap, tweak and reject are offered.
   * "saved": just the collage, items and save/like.
   */
  mode: "results" | "saved";
  /** A refinement is in flight somewhere on the page: hold off on another. */
  refineBusy?: boolean;
  onSwap?: (item: WardrobeItem) => void;
  onRefine?: (guidance: string) => void;
}

export function OutfitCard(props: OutfitCardProps) {
  const { outfit, status, mode } = props;

  if (status === "rejected" && mode === "results") {
    return (
      <Card data-testid="outfit-card" data-outfit-id={outfit.id} data-status={status} className="gap-0 py-3">
        <CardContent className="flex items-center justify-between gap-3 px-4">
          <p className="text-muted-foreground text-sm">
            You rejected <span className="text-foreground font-medium">{outfit.name}</span>.
          </p>
          <Button
            type="button"
            variant="ghost"
            disabled={props.statusBusy}
            onClick={() => props.onStatusChange({ status: "suggested" })}
          >
            <Undo2Icon aria-hidden />
            Undo
          </Button>
        </CardContent>
      </Card>
    );
  }

  const anchorId = outfit.request.anchorItemId;

  return (
    <Card data-testid="outfit-card" data-outfit-id={outfit.id} data-status={status} className="gap-4 py-4">
      <CardHeader className="gap-1 px-4">
        <CardTitle>
          <h3 className="text-lg">{outfit.name}</h3>
        </CardTitle>
        <CardDescription>{outfit.reason}</CardDescription>
        {mode === "saved" && (
          <p className="text-muted-foreground text-xs">For {styleLabel(outfit.request.style)}</p>
        )}
      </CardHeader>
      <CardContent className="space-y-4 px-4">
        <OutfitCollage name={outfit.name} items={outfit.items} />

        <FeedbackBar
          outfitName={outfit.name}
          status={status}
          busy={props.statusBusy}
          allowReject={mode === "results"}
          onChange={props.onStatusChange}
        />

        <ItemList
          items={outfit.items}
          anchorId={anchorId}
          swapDisabled={props.refineBusy ?? false}
          onSwap={mode === "results" ? props.onSwap : undefined}
        />

        {mode === "results" && props.onRefine && (
          <TweakForm outfitName={outfit.name} disabled={props.refineBusy ?? false} onRefine={props.onRefine} />
        )}
      </CardContent>
    </Card>
  );
}

function ItemList(props: {
  items: readonly WardrobeItem[];
  anchorId: string | null;
  swapDisabled: boolean;
  onSwap?: (item: WardrobeItem) => void;
}) {
  return (
    <ul className="divide-y rounded-lg border" aria-label="Items in this outfit">
      {props.items.map((item) => {
        const isAnchor = item.id === props.anchorId;
        return (
          <li key={item.id} className="flex items-center gap-3 px-3 py-1.5">
            {/* Signed storage URLs change hourly, so next/image's optimiser can't cache them. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={displayImageUrl(item)}
              alt=""
              crossOrigin="anonymous"
              className="bg-muted size-11 shrink-0 rounded-md object-contain p-0.5"
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{item.tags.description}</p>
              <p className="text-muted-foreground text-xs">{subcategoryLabel(item.tags.subcategory)}</p>
            </div>
            {isAnchor ? (
              <Badge variant="secondary">Your pick</Badge>
            ) : (
              props.onSwap && (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={props.swapDisabled}
                  onClick={() => props.onSwap?.(item)}
                  aria-label={`Swap ${item.tags.description}`}
                >
                  <RefreshCwIcon aria-hidden />
                  Swap
                </Button>
              )
            )}
          </li>
        );
      })}
    </ul>
  );
}

function TweakForm(props: { outfitName: string; disabled: boolean; onRefine: (guidance: string) => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const inputId = useId();
  const panelId = useId();

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const clean = text.replace(/\s+/g, " ").trim();
    if (clean) props.onRefine(clean);
  }

  return (
    <div className="space-y-3">
      <Button
        type="button"
        variant="outline"
        className="w-full"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
      >
        <SlidersHorizontalIcon aria-hidden />
        Tweak this outfit
      </Button>
      {open && (
        <div id={panelId} className="space-y-3">
          <div className="flex flex-wrap gap-2" role="group" aria-label="Quick tweaks">
            {QUICK_REFINEMENTS.map((label) => (
              <Button
                key={label}
                type="button"
                variant="secondary"
                disabled={props.disabled}
                onClick={() => props.onRefine(label.toLowerCase())}
              >
                {label}
              </Button>
            ))}
          </div>
          <form onSubmit={submit} className="flex gap-2">
            <label htmlFor={inputId} className="sr-only">
              What would you change about {props.outfitName}?
            </label>
            <Input
              id={inputId}
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={GUIDANCE_MAX_LENGTH}
              placeholder="Or say what to change"
              enterKeyHint="send"
            />
            <Button type="submit" disabled={props.disabled || !text.trim()}>
              Update
            </Button>
          </form>
        </div>
      )}
    </div>
  );
}
