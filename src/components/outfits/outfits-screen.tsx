"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeftIcon, BookmarkIcon, Undo2Icon } from "lucide-react";
import type {
  Outfit,
  OutfitGenerationResponse,
  OutfitRequestInput,
  OutfitStatus,
  RefineRequest,
  UpdateOutfitStatusRequest,
  WardrobeItem,
} from "@/contracts";
import { OUTFIT_COUNT } from "@/contracts";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { outfitsApi, type ApiFailure } from "./api";
import { fewerOutfitsMessage, styleLabel } from "./copy";
import { isStale, refetchOutfits } from "./freshness";
import { PAGE_BOTTOM_PADDING_STYLE } from "./layout";
import { OutfitCard } from "./outfit-card";
import { EMPTY_DRAFT, draftToRequest, type DraftField, type RequestDraft } from "./request-draft";
import { RequestForm, type AnchorState } from "./request-form";
import { ApiErrorNotice, IncompleteWardrobeNotice } from "./result-notices";

/** One set of suggestions. Refining adds a new set; "Back" returns to the one before. */
interface ResultSet {
  key: number;
  heading: string;
  detail: string | null;
  response: OutfitGenerationResponse;
  /** How many outfits were asked for, when known (new requests; refinements don't say). */
  requested: number | null;
  /** When the outfits (and their signed image URLs) were fetched, for re-fetching stale ones. */
  fetchedAt: number;
}

type Pending = { kind: "request" } | { kind: "refine"; label: string } | { kind: "refresh" };

/** Load the anchor item. Only a 404 means it's gone; anything else can be retried. */
async function loadAnchor(id: string): Promise<AnchorState> {
  const result = await outfitsApi.getItem(id);
  if (result.ok) return { status: "ready", item: result.data.item };
  if (result.error.code === "not_found") return { status: "missing" };
  return { status: "error", id, error: result.error };
}

/** The time now. A plain function, so the React compiler doesn't read it as render-time impurity. */
function timestamp(): number {
  return Date.now();
}

/** Replace an outfit wherever it appears in the sets, e.g. after fetching fresh image URLs. */
function replaceOutfit(sets: ResultSet[], fresh: Outfit): ResultSet[] {
  return sets.map((set) =>
    set.response.status === "ok" && set.response.outfits.some((o) => o.id === fresh.id)
      ? {
          ...set,
          response: { ...set.response, outfits: set.response.outfits.map((o) => (o.id === fresh.id ? fresh : o)) },
        }
      : set,
  );
}

/**
 * /outfits: ask for outfits (style, guidance, count, optional anchor item),
 * then see the results, refine them and give feedback.
 */
export function OutfitsScreen({ initialAnchorId }: { initialAnchorId: string | null }) {
  const [draft, setDraft] = useState<RequestDraft>(EMPTY_DRAFT);
  const [formError, setFormError] = useState<{ field: DraftField; message: string } | null>(null);
  const [anchor, setAnchor] = useState<AnchorState>(
    initialAnchorId ? { status: "loading", id: initialAnchorId } : { status: "none" },
  );

  const [view, setView] = useState<"form" | "results">("form");
  const [sets, setSets] = useState<ResultSet[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState<{ error: ApiFailure; retry: (() => void) | null } | null>(null);

  const [statuses, setStatuses] = useState<Record<string, OutfitStatus>>({});
  const [statusBusy, setStatusBusy] = useState<Record<string, boolean>>({});
  const [statusErrors, setStatusErrors] = useState<Record<string, ApiFailure | null>>({});
  const nextKey = useRef(1);
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Load the anchor item when we arrive from "Build an outfit around this".
  useEffect(() => {
    if (!initialAnchorId) return;
    let cancelled = false;
    void loadAnchor(initialAnchorId).then((next) => {
      if (!cancelled) setAnchor(next);
    });
    return () => {
      cancelled = true;
    };
  }, [initialAnchorId]);

  const current = sets.at(-1) ?? null;

  // Move focus to the heading when a new set of results arrives, so screen
  // readers (and keyboards) start from the top of the new results.
  const currentKey = current?.key;
  useEffect(() => {
    if (currentKey !== undefined) headingRef.current?.focus({ preventScroll: true });
  }, [currentKey]);

  const anchorItem: WardrobeItem | null = anchor.status === "ready" ? anchor.item : null;

  function retryAnchor() {
    if (anchor.status !== "error") return;
    const id = anchor.id;
    setAnchor({ status: "loading", id });
    void loadAnchor(id).then(setAnchor);
  }

  function removeAnchor() {
    setAnchor({ status: "none" });
    // Drop ?anchor= from the address without reloading the page.
    window.history.replaceState(null, "", "/outfits");
  }

  function scrollToTop() {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function runRequest(request: OutfitRequestInput) {
    setView("results");
    setSets([]);
    setError(null);
    setPending({ kind: "request" });
    scrollToTop();

    const result = await outfitsApi.requestOutfits(request);
    setPending(null);
    if (!result.ok) {
      setError({ error: result.error, retry: () => void runRequest(request) });
      return;
    }
    const details = [
      anchorItem ? `With your ${anchorItem.tags.description.toLowerCase()}` : null,
      request.guidance ? `“${request.guidance}”` : null,
    ].filter(Boolean);
    setSets([
      {
        key: nextKey.current++,
        heading: `Outfits for ${styleLabel(request.style)}`,
        detail: details.length ? details.join(" · ") : null,
        response: result.data,
        requested: request.count ?? OUTFIT_COUNT.default,
        fetchedAt: timestamp(),
      },
    ]);
  }

  async function runRefine(outfit: Outfit, refine: RefineRequest, label: string) {
    setError(null);
    setPending({ kind: "refine", label });
    const result = await outfitsApi.refineOutfit(outfit.id, refine);
    setPending(null);
    if (!result.ok) {
      setError({ error: result.error, retry: () => void runRefine(outfit, refine, label) });
      return;
    }
    setSets((previous) => [
      ...previous,
      {
        key: nextKey.current++,
        heading: label,
        detail: `New ideas based on ${outfit.name}`,
        response: result.data,
        requested: null,
        fetchedAt: timestamp(),
      },
    ]);
    scrollToTop();
  }

  /** "Back to previous ideas", fetching that set again first if its image URLs may have expired. */
  async function goBack() {
    const previous = sets.at(-2);
    if (!previous) return;
    setError(null);
    if (previous.response.status === "ok" && isStale(previous.fetchedAt)) {
      setPending({ kind: "refresh" });
      const fresh = await refetchOutfits(previous.response.outfits);
      setPending(null);
      setSets((s) => [
        ...s.slice(0, -2),
        { ...previous, response: { ...previous.response, outfits: fresh }, fetchedAt: timestamp() },
      ]);
    } else {
      setSets((s) => s.slice(0, -1));
    }
    scrollToTop();
  }

  /** "Reload pictures" on one outfit: fetch it again for fresh image URLs. */
  async function reloadPictures(outfit: Outfit) {
    const result = await outfitsApi.getOutfit(outfit.id);
    if (result.ok) setSets((s) => replaceOutfit(s, result.data.outfit));
    else setStatusErrors((e) => ({ ...e, [outfit.id]: result.error }));
  }

  async function changeStatus(outfit: Outfit, update: UpdateOutfitStatusRequest) {
    setStatusBusy((b) => ({ ...b, [outfit.id]: true }));
    setStatusErrors((e) => ({ ...e, [outfit.id]: null }));
    const result = await outfitsApi.setOutfitStatus(outfit.id, update);
    setStatusBusy((b) => ({ ...b, [outfit.id]: false }));
    if (result.ok) {
      setStatuses((s) => ({ ...s, [outfit.id]: result.data.outfit.status }));
    } else {
      // Shown on the card that was tapped, not at the top of the page.
      setStatusErrors((e) => ({ ...e, [outfit.id]: result.error }));
    }
  }

  function submit() {
    const result = draftToRequest(draft, anchorItem?.id ?? null);
    if (!result.ok) {
      setFormError({ field: result.field, message: result.message });
      return;
    }
    setFormError(null);
    void runRequest(result.request);
  }

  const outfits = current?.response.status === "ok" ? current.response.outfits : null;
  const fewerThanAsked = outfits && current?.requested && outfits.length < current.requested ? outfits.length : null;

  return (
    <main className="mx-auto w-full max-w-md px-4 pt-4" style={PAGE_BOTTOM_PADDING_STYLE}>
      <header className="mb-4 flex items-center justify-between gap-2">
        {view === "results" ? (
          <Button
            type="button"
            variant="ghost"
            className="-ml-3"
            onClick={() => {
              setView("form");
              setError(null);
            }}
          >
            <ArrowLeftIcon aria-hidden />
            Change request
          </Button>
        ) : (
          <h1 className="text-2xl font-semibold tracking-tight">Outfit ideas</h1>
        )}
        <Button asChild variant="ghost" className="-mr-3">
          <Link href="/outfits/saved">
            <BookmarkIcon aria-hidden />
            Saved
          </Link>
        </Button>
      </header>

      {view === "form" ? (
        <RequestForm
          draft={draft}
          onDraftChange={(d) => {
            setDraft(d);
            if (formError) setFormError(null);
          }}
          anchor={anchor}
          onRemoveAnchor={removeAnchor}
          onRetryAnchor={retryAnchor}
          error={formError}
          submitting={pending !== null}
          onSubmit={submit}
        />
      ) : (
        <section aria-labelledby="results-heading" className="space-y-4">
          <div className="space-y-1">
            <h1
              id="results-heading"
              ref={headingRef}
              tabIndex={-1}
              className="text-2xl font-semibold tracking-tight outline-none"
            >
              {current?.heading ?? "Finding outfits…"}
            </h1>
            {current?.detail && <p className="text-muted-foreground text-sm">{current.detail}</p>}
          </div>

          <p role="status" aria-live="polite" className={pending ? "text-sm font-medium" : "sr-only"}>
            {pending?.kind === "request" && "Putting outfits together…"}
            {pending?.kind === "refine" && `Working on it: ${pending.label.toLowerCase()}…`}
            {pending?.kind === "refresh" && "Getting those ideas back…"}
          </p>

          {error && <ApiErrorNotice error={error.error} onRetry={error.retry ?? undefined} />}

          {pending?.kind === "request" && <ResultsSkeleton />}

          {current && sets.length > 1 && (
            <Button
              type="button"
              variant="outline"
              className="w-full"
              // Not while a refine is running: its result would land on the wrong set.
              disabled={pending !== null}
              onClick={() => void goBack()}
            >
              <Undo2Icon aria-hidden />
              Back to previous ideas
            </Button>
          )}

          {current?.response.status === "incomplete_wardrobe" && (
            <IncompleteWardrobeNotice result={current.response} onChangeRequest={() => setView("form")} />
          )}

          {fewerThanAsked !== null && (
            <p className="text-muted-foreground text-sm" data-testid="fewer-outfits">
              {fewerOutfitsMessage(fewerThanAsked)}
            </p>
          )}

          {outfits && current && (
            <ol
              key={current.key}
              className="space-y-4"
              aria-label="Suggested outfits"
              aria-busy={pending?.kind === "refine"}
            >
              {outfits.map((outfit) => (
                <li key={outfit.id}>
                  <OutfitCard
                    outfit={outfit}
                    mode="results"
                    status={statuses[outfit.id] ?? outfit.status}
                    statusBusy={statusBusy[outfit.id] ?? false}
                    statusError={statusErrors[outfit.id] ?? null}
                    onStatusChange={(update) => void changeStatus(outfit, update)}
                    onReloadPictures={() => reloadPictures(outfit)}
                    refineBusy={pending !== null}
                    onSwap={(item) =>
                      void runRefine(outfit, { kind: "swap", itemId: item.id }, `Swapped out the ${item.tags.description.toLowerCase()}`)
                    }
                    onRefine={(text) => void runRefine(outfit, { kind: "guidance", text }, `Tweaked: ${text}`)}
                  />
                </li>
              ))}
            </ol>
          )}
        </section>
      )}
    </main>
  );
}

function ResultsSkeleton() {
  return (
    <div className="space-y-4" aria-hidden>
      {[0, 1].map((i) => (
        <div key={i} className="space-y-3 rounded-xl border p-4">
          <Skeleton className="h-5 w-1/2" />
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="aspect-[4/5] w-full" />
        </div>
      ))}
    </div>
  );
}
