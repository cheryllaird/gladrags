"use client";

import Link from "next/link";
import { CircleAlertIcon, ListChecksIcon, PlusIcon, ShirtIcon } from "lucide-react";
import type { Category, OutfitGenerationResponse } from "@/contracts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { ApiFailure } from "./api";
import { CATEGORY_LABELS, describeApiError, type ErrorContext } from "./copy";
import { missingCategoriesMessage } from "./gap-copy";

type IncompleteWardrobe = Extract<OutfitGenerationResponse, { status: "incomplete_wardrobe" }>;

/**
 * Outfits came back, but some slots are gaps because the wardrobe has no
 * items of that kind: "Add shoes to your wardrobe to complete these outfits."
 */
export function MissingCategoriesNotice({ categories }: { categories: readonly Category[] }) {
  const message = missingCategoriesMessage(categories);
  if (!message) return null;
  return (
    <section data-testid="missing-categories" aria-label="Complete these outfits" className="bg-muted/50 space-y-2 rounded-xl border p-4">
      <p className="text-sm">{message}</p>
      <p className="text-muted-foreground text-xs">The dashed pieces are suggestions for now.</p>
      <Button asChild variant="outline" className="w-full">
        <Link href="/add">
          <PlusIcon aria-hidden />
          Add clothes
        </Link>
      </Button>
    </section>
  );
}

/**
 * The wardrobe can't make an outfit for this request. Not an error: the
 * wardrobe is empty (point to the get-started checklist), nothing suits the
 * style, or (legacy, from before gaps) a category is missing.
 */
export function IncompleteWardrobeNotice(props: { result: IncompleteWardrobe; onChangeRequest: () => void }) {
  const { result } = props;

  if (result.reason === "empty_wardrobe") {
    return (
      <section
        data-testid="incomplete-wardrobe"
        data-reason="empty_wardrobe"
        aria-labelledby="empty-title"
        className="space-y-4 rounded-xl border p-5"
      >
        <ShirtIcon aria-hidden className="text-muted-foreground size-8" />
        <div className="space-y-1">
          <h2 id="empty-title" className="text-lg font-semibold">
            Add your first piece to get outfits
          </h2>
          <p className="text-muted-foreground text-sm">
            Outfits work from your very first item: anything missing is filled with a suggestion.
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <Button asChild>
            <Link href="/wardrobe">
              <ListChecksIcon aria-hidden />
              Get started
            </Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/add">
              <PlusIcon aria-hidden />
              Add clothes
            </Link>
          </Button>
        </div>
      </section>
    );
  }

  // Legacy (before gaps): kept so an older engine's answer still makes sense.
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

/**
 * Sign-in, coming back to this screen afterwards. Errors only appear after a
 * request made in the browser, so `window` is always there when this runs.
 */
function signInHref(): string {
  const here = typeof window === "undefined" ? "/outfits" : `${window.location.pathname}${window.location.search}`;
  return `/sign-in?next=${encodeURIComponent(here)}`;
}

/** A friendly message for an API error, with "Try again" when that's worth doing. */
export function ApiErrorNotice(props: { error: ApiFailure; onRetry?: () => void; context?: ErrorContext }) {
  const context = props.context ?? "outfits";
  const copy = describeApiError(props.error, context);
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
        {props.error.code === "unauthorized" && (
          <Link href={signInHref()} className="mt-1 inline-flex min-h-11 items-center text-sm underline underline-offset-4">
            Sign in again
          </Link>
        )}
        {context === "outfits" && (props.error.code === "ai_paused" || props.error.code === "daily_cap_reached") ? (
          <Link href="/outfits/saved" className="mt-1 inline-flex min-h-11 items-center text-sm underline underline-offset-4">
            See saved outfits
          </Link>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
