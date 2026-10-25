"use client";

import Link from "next/link";
import { CircleAlertIcon, PlusIcon, ShirtIcon } from "lucide-react";
import type { OutfitGenerationResponse } from "@/contracts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { ApiFailure } from "./api";
import { CATEGORY_LABELS, describeApiError } from "./copy";

type IncompleteWardrobe = Extract<OutfitGenerationResponse, { status: "incomplete_wardrobe" }>;

/**
 * The wardrobe can't make an outfit for this request. Not an error: either
 * a category is missing (link to add one), or nothing suits the style.
 */
export function IncompleteWardrobeNotice(props: { result: IncompleteWardrobe; onChangeRequest: () => void }) {
  const { result } = props;

  if (result.reason === "missing_category") {
    return (
      <section
        data-testid="incomplete-wardrobe"
        data-reason="missing_category"
        aria-labelledby="missing-title"
        className="space-y-4 rounded-xl border p-5"
      >
        <ShirtIcon aria-hidden className="text-muted-foreground size-8" />
        <div className="space-y-1">
          <h2 id="missing-title" className="text-lg font-semibold">
            Your wardrobe needs a few more pieces
          </h2>
          <p className="text-muted-foreground text-sm">{result.message}</p>
        </div>
        <ul className="space-y-2" aria-label="Missing from your wardrobe">
          {result.missingCategories.map((category) => (
            <li key={category}>
              <Button asChild variant="outline" className="w-full justify-start">
                <Link href="/add">
                  <PlusIcon aria-hidden />
                  {CATEGORY_LABELS[category].add}
                </Link>
              </Button>
            </li>
          ))}
        </ul>
        <p className="text-muted-foreground text-xs">
          An outfit needs a top and bottom (or a dress or jumpsuit) and a pair of shoes.
        </p>
      </section>
    );
  }

  return (
    <section
      data-testid="incomplete-wardrobe"
      data-reason="nothing_fits"
      aria-labelledby="nothing-fits-title"
      className="space-y-4 rounded-xl border p-5"
    >
      <ShirtIcon aria-hidden className="text-muted-foreground size-8" />
      <div className="space-y-1">
        <h2 id="nothing-fits-title" className="text-lg font-semibold">
          Nothing quite fits this one
        </h2>
        <p className="text-muted-foreground text-sm">{result.message}</p>
        <p className="text-muted-foreground text-sm">
          Try a different style, loosen your guidance, or add a few pieces that suit it.
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <Button type="button" onClick={props.onChangeRequest}>
          Change request
        </Button>
        <Button asChild variant="outline">
          <Link href="/add">Add clothes</Link>
        </Button>
      </div>
    </section>
  );
}

/** A friendly message for an API error, with "Try again" when that's worth doing. */
export function ApiErrorNotice(props: { error: ApiFailure; onRetry?: () => void }) {
  const copy = describeApiError(props.error);
  return (
    <Alert data-testid="api-error" data-code={props.error.code}>
      <CircleAlertIcon aria-hidden />
      <AlertTitle className="line-clamp-none">{copy.title}</AlertTitle>
      <AlertDescription>
        <p>{copy.message}</p>
        {copy.retryable && props.onRetry && (
          <Button type="button" variant="outline" className="mt-2" onClick={props.onRetry}>
            Try again
          </Button>
        )}
        {props.error.code === "ai_paused" || props.error.code === "daily_cap_reached" ? (
          <Link href="/outfits/saved" className="mt-1 inline-flex min-h-11 items-center text-sm underline underline-offset-4">
            See saved outfits
          </Link>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
