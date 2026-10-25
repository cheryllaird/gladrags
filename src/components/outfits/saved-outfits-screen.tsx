"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { SparklesIcon } from "lucide-react";
import type { Outfit, OutfitStatus, UpdateOutfitStatusRequest } from "@/contracts";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { outfitsApi, type ApiFailure } from "./api";
import { PAGE_BOTTOM_PADDING_STYLE } from "./layout";
import { OutfitCard } from "./outfit-card";
import { ApiErrorNotice } from "./result-notices";

type Filter = "all" | "saved" | "liked";
const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "saved", label: "Saved" },
  { id: "liked", label: "Liked" },
];

type LoadState = { status: "loading" } | { status: "error"; error: ApiFailure } | { status: "ready"; outfits: Outfit[] };

/** Saved and liked outfits together, newest first. */
async function loadKeptOutfits(): Promise<{ ok: true; outfits: Outfit[] } | { ok: false; error: ApiFailure }> {
  const [saved, liked] = await Promise.all([
    outfitsApi.listOutfits({ status: "saved" }),
    outfitsApi.listOutfits({ status: "liked" }),
  ]);
  if (!saved.ok) return saved;
  if (!liked.ok) return liked;
  const outfits = [...saved.data.outfits, ...liked.data.outfits].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { ok: true, outfits };
}

/** /outfits/saved */
export function SavedOutfitsScreen() {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [filter, setFilter] = useState<Filter>("all");
  const [statuses, setStatuses] = useState<Record<string, OutfitStatus>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [actionError, setActionError] = useState<ApiFailure | null>(null);

  const load = useCallback(async () => {
    const result = await loadKeptOutfits();
    setState(result.ok ? { status: "ready", outfits: result.outfits } : { status: "error", error: result.error });
  }, []);

  useEffect(() => {
    let cancelled = false;
    void loadKeptOutfits().then((result) => {
      if (cancelled) return;
      setState(result.ok ? { status: "ready", outfits: result.outfits } : { status: "error", error: result.error });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function changeStatus(outfit: Outfit, update: UpdateOutfitStatusRequest) {
    setBusy((b) => ({ ...b, [outfit.id]: true }));
    setActionError(null);
    const result = await outfitsApi.setOutfitStatus(outfit.id, update);
    setBusy((b) => ({ ...b, [outfit.id]: false }));
    if (result.ok) setStatuses((s) => ({ ...s, [outfit.id]: result.data.outfit.status }));
    else setActionError(result.error);
  }

  // Un-saving keeps the outfit on screen (so the button doesn't jump away
  // under your thumb) until you next open this screen.
  const statusOf = (o: Outfit) => statuses[o.id] ?? o.status;
  const visible =
    state.status === "ready"
      ? state.outfits.filter((o) => filter === "all" || o.status === filter)
      : [];

  return (
    <main className="mx-auto w-full max-w-md px-4 pt-4" style={PAGE_BOTTOM_PADDING_STYLE}>
      <header className="mb-4 flex items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Saved outfits</h1>
        <Button asChild variant="ghost" className="-mr-3">
          <Link href="/outfits">
            <SparklesIcon aria-hidden />
            New ideas
          </Link>
        </Button>
      </header>

      {state.status === "loading" && (
        <div className="space-y-4" aria-busy="true" aria-label="Loading saved outfits">
          <Skeleton className="h-11 w-full" />
          <Skeleton className="aspect-[4/5] w-full" />
        </div>
      )}

      {state.status === "error" && <ApiErrorNotice error={state.error} onRetry={() => void load()} />}

      {state.status === "ready" && state.outfits.length === 0 && (
        <section className="space-y-3 rounded-xl border p-5 text-center" data-testid="saved-empty">
          <h2 className="text-lg font-semibold">Nothing saved yet</h2>
          <p className="text-muted-foreground text-sm">
            Save or like outfits from your suggestions and they&apos;ll appear here.
          </p>
          <Button asChild className="w-full">
            <Link href="/outfits">Get outfit ideas</Link>
          </Button>
        </section>
      )}

      {state.status === "ready" && state.outfits.length > 0 && (
        <div className="space-y-4">
          <div role="radiogroup" aria-label="Show" className="flex gap-2">
            {FILTERS.map((f) => (
              <Button
                key={f.id}
                type="button"
                role="radio"
                aria-checked={filter === f.id}
                variant={filter === f.id ? "default" : "outline"}
                className="flex-1"
                onClick={() => setFilter(f.id)}
              >
                {f.label}
              </Button>
            ))}
          </div>

          {actionError && <ApiErrorNotice error={actionError} />}

          {visible.length === 0 ? (
            <p className="text-muted-foreground py-6 text-center text-sm">No {filter} outfits yet.</p>
          ) : (
            <ol className="space-y-4" aria-label="Saved and liked outfits">
              {visible.map((outfit) => (
                <li key={outfit.id}>
                  <OutfitCard
                    outfit={outfit}
                    mode="saved"
                    status={statusOf(outfit)}
                    statusBusy={busy[outfit.id] ?? false}
                    onStatusChange={(update) => void changeStatus(outfit, update)}
                  />
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </main>
  );
}
