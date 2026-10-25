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
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { outfitsApi, type ApiFailure } from "./api";
import { styleLabel } from "./copy";
import { PAGE_BOTTOM_PADDING_STYLE } from "./layout";
import { OutfitCard } from "./outfit-card";
import { EMPTY_DRAFT, draftToRequest, type RequestDraft } from "./request-draft";
import { RequestForm, type AnchorState } from "./request-form";
import { ApiErrorNotice, IncompleteWardrobeNotice } from "./result-notices";

/** One set of suggestions. Refining adds a new set; "Back" returns to the one before. */
interface ResultSet {
  key: number;
  heading: string;
  detail: string | null;
  response: OutfitGenerationResponse;
}

type Pending = { kind: "request" } | { kind: "refine"; label: string };

/**
 * /outfits: ask for outfits (style, guidance, count, optional anchor item),
 * then see the results, refine them and give feedback.
 */
export function OutfitsScreen({ initialAnchorId }: { initialAnchorId: string | null }) {
  const [draft, setDraft] = useState<RequestDraft>(EMPTY_DRAFT);
  const [formError, setFormError] = useState<{ field: string; message: string } | null>(null);
  const [anchor, setAnchor] = useState<AnchorState>(
    initialAnchorId ? { status: "loading", id: initialAnchorId } : { status: "none" },
  );

  const [view, setView] = useState<"form" | "results">("form");
  const [sets, setSets] = useState<ResultSet[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState<{ error: ApiFailure; retry: (() => void) | null } | null>(null);

  const [statuses, setStatuses] = useState<Record<string, OutfitStatus>>({});
  const [statusBusy, setStatusBusy] = useState<Record<string, boolean>>({});
  const nextKey = useRef(1);

  // Load the anchor item when we arrive from "Build an outfit around this".
  useEffect(() => {
    if (!initialAnchorId) return;
    let cancelled = false;
    async function load(id: string) {
      const result = await outfitsApi.getItem(id);
      if (cancelled) return;
      setAnchor(result.ok ? { status: "ready", item: result.data.item } : { status: "missing" });
    }
    void load(initialAnchorId);
    return () => {
      cancelled = true;
    };
  }, [initialAnchorId]);

  const anchorItem: WardrobeItem | null = anchor.status === "ready" ? anchor.item : null;

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
      },
    ]);
    scrollToTop();
  }

  async function changeStatus(outfit: Outfit, update: UpdateOutfitStatusRequest) {
    setStatusBusy((b) => ({ ...b, [outfit.id]: true }));
    const result = await outfitsApi.setOutfitStatus(outfit.id, update);
    setStatusBusy((b) => ({ ...b, [outfit.id]: false }));
    if (result.ok) {
      setStatuses((s) => ({ ...s, [outfit.id]: result.data.outfit.status }));
    } else {
      setError({ error: result.error, retry: null });
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

  const current = sets.at(-1) ?? null;

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
          error={formError}
          submitting={pending !== null}
          onSubmit={submit}
        />
      ) : (
        <section aria-labelledby="results-heading" className="space-y-4">
          <div className="space-y-1">
            <h1 id="results-heading" className="text-2xl font-semibold tracking-tight">
              {current?.heading ?? "Finding outfits…"}
            </h1>
            {current?.detail && <p className="text-muted-foreground text-sm">{current.detail}</p>}
          </div>

          <p role="status" aria-live="polite" className={pending ? "text-sm font-medium" : "sr-only"}>
            {pending?.kind === "request" && "Putting outfits together…"}
            {pending?.kind === "refine" && `Working on it: ${pending.label.toLowerCase()}…`}
          </p>

          {error && <ApiErrorNotice error={error.error} onRetry={error.retry ?? undefined} />}

          {pending?.kind === "request" && <ResultsSkeleton />}

          {current && sets.length > 1 && (
            <Button type="button" variant="outline" className="w-full" onClick={() => setSets((s) => s.slice(0, -1))}>
              <Undo2Icon aria-hidden />
              Back to previous ideas
            </Button>
          )}

          {current?.response.status === "incomplete_wardrobe" && (
            <IncompleteWardrobeNotice result={current.response} onChangeRequest={() => setView("form")} />
          )}

          {current?.response.status === "ok" && (
            <ol
              key={current.key}
              className="space-y-4"
              aria-label="Suggested outfits"
              aria-busy={pending?.kind === "refine"}
            >
              {current.response.outfits.map((outfit) => (
                <li key={outfit.id}>
                  <OutfitCard
                    outfit={outfit}
                    mode="results"
                    status={statuses[outfit.id] ?? outfit.status}
                    statusBusy={statusBusy[outfit.id] ?? false}
                    onStatusChange={(update) => void changeStatus(outfit, update)}
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
