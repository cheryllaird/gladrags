"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { SparklesIcon } from "lucide-react";
import type { Outfit, OutfitStatus, UpdateOutfitStatusRequest } from "@/contracts";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { outfitsApi, type ApiFailure } from "./api";
import { isStale } from "./freshness";
import { PAGE_BOTTOM_PADDING_STYLE } from "./layout";
import { outfitsForFilter, type SavedFilter as Filter } from "./saved-filter";
import { OutfitCard } from "./outfit-card";
import { ApiErrorNotice } from "./result-notices";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "saved", label: "Saved" },
  { id: "liked", label: "Liked" },
];

type LoadState =
  | { status: "loading" }
  | { status: "error"; error: ApiFailure }
  /** `fetchedAt`: when, so expired image URLs can be fetched again. */
  | { status: "ready"; outfits: Outfit[]; fetchedAt: number };

/** Saved and liked outfits together, newest first. */
async function loadKeptOutfits(): Promise<LoadState> {
  const [saved, liked] = await Promise.all([
    outfitsApi.listOutfits({ status: "saved" }),
    outfitsApi.listOutfits({ status: "liked" }),
  ]);
  if (!saved.ok) return { status: "error", error: saved.error };
  if (!liked.ok) return { status: "error", error: liked.error };
  const outfits = [...saved.data.outfits, ...liked.data.outfits].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { status: "ready", outfits, fetchedAt: Date.now() };
}

/** /outfits/saved */
export function SavedOutfitsScreen() {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [filter, setFilter] = useState<Filter>("all");
  const [statuses, setStatuses] = useState<Record<string, OutfitStatus>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, ApiFailure | null>>({});

  const load = useCallback(async () => {
    setState(await loadKeptOutfits());
  }, []);

  useEffect(() => {
    let cancelled = false;
    void loadKeptOutfits().then((result) => {
      if (!cancelled) setState(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  function chooseFilter(next: Filter) {
    setFilter(next);
    // Switching filter remounts cards; fetch again if their image URLs may have expired.
    if (state.status === "ready" && isStale(state.fetchedAt)) void load();
  }

  async function changeStatus(outfit: Outfit, update: UpdateOutfitStatusRequest) {
    setBusy((b) => ({ ...b, [outfit.id]: true }));
    setErrors((e) => ({ ...e, [outfit.id]: null }));
    const result = await outfitsApi.setOutfitStatus(outfit.id, update);
    setBusy((b) => ({ ...b, [outfit.id]: false }));
    if (result.ok) setStatuses((s) => ({ ...s, [outfit.id]: result.data.outfit.status }));
    else setErrors((e) => ({ ...e, [outfit.id]: result.error }));
  }

  /** Keep the outfit as the server now has it (after a shop search or pick), with its status as shown. */
  function replaceOutfit(fresh: Outfit) {
    setState((s) =>
      s.status === "ready" ? { ...s, outfits: s.outfits.map((o) => (o.id === fresh.id ? { ...fresh, status: o.status } : o)) } : s,
    );
  }

  /** "Reload pictures": fetch one outfit again for fresh image URLs. */
  async function reloadPictures(outfit: Outfit) {
    const result = await outfitsApi.getOutfit(outfit.id);
    if (!result.ok) {
      setErrors((e) => ({ ...e, [outfit.id]: result.error }));
      return;
    }
    replaceOutfit(result.data.outfit);
  }

  const visible = state.status === "ready" ? outfitsForFilter(state.outfits, filter, statuses) : [];

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
                onClick={() => chooseFilter(f.id)}
              >
                {f.label}
              </Button>
            ))}
          </div>

          {visible.length === 0 ? (
            <p className="text-muted-foreground py-6 text-center text-sm">No {filter} outfits yet.</p>
          ) : (
            <ol className="space-y-4" aria-label="Saved and liked outfits">
              {visible.map((outfit) => (
                <li key={outfit.id}>
                  <OutfitCard
                    outfit={outfit}
                    mode="saved"
                    status={statuses[outfit.id] ?? outfit.status}
                    statusBusy={busy[outfit.id] ?? false}
                    statusError={errors[outfit.id] ?? null}
                    onStatusChange={(update) => void changeStatus(outfit, update)}
                    onReloadPictures={() => reloadPictures(outfit)}
                    onOutfitChange={replaceOutfit}
                    // A long saved list would otherwise hold a full-size canvas per outfit.
                    lazyCollage
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
