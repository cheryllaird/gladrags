"use client";

import { LogOutIcon, PlusIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import type { WardrobeItem } from "@/contracts";
import { PageBody, PageHeader } from "@/components/app-shell/page-header";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiErrorNotice } from "@/components/wardrobe/api-error-notice";
import { ItemImage } from "@/components/wardrobe/item-image";
import {
  NO_FILTERS,
  filtersToQuery,
  filtersToSearch,
  type WardrobeFilters,
} from "@/components/wardrobe/wardrobe-filter-values";
import { WardrobeFiltersBar } from "@/components/wardrobe/wardrobe-filters";
import { listItems } from "@/lib/client/api";

/** Wait this long after typing stops before searching. */
const SEARCH_DEBOUNCE_MS = 250;

/** The last answer from the API, and which request (query + attempt) it answers. */
type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; key: string; items: WardrobeItem[]; filtered: boolean }
  | { kind: "error"; key: string; error: unknown };

export function WardrobeScreen({ initialFilters }: { initialFilters: WardrobeFilters }) {
  const [filters, setFilters] = useState(initialFilters);
  // The filters the list is fetched for: selects at once, search after a pause.
  const [query, setQuery] = useState(() => filtersToQuery(initialFilters));
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  const key = `${JSON.stringify(query)}#${attempt}`;

  useEffect(() => {
    let current = true;
    listItems(query).then(
      (items) => current && setState({ kind: "ready", key, items, filtered: Object.keys(query).length > 0 }),
      (error: unknown) => current && setState({ kind: "error", key, error }),
    );
    // A newer request replaces this one; ignore its late answer.
    return () => {
      current = false;
    };
  }, [query, key]);

  useEffect(() => {
    const next = filtersToQuery(filters);
    const delay = (next.q ?? "") === (query.q ?? "") ? 0 : SEARCH_DEBOUNCE_MS;
    const timer = window.setTimeout(() => {
      setQuery((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
    }, delay);
    // Keep the filters in the address bar so back and reload keep them.
    window.history.replaceState(window.history.state, "", `/wardrobe${filtersToSearch(filters)}`);
    return () => window.clearTimeout(timer);
  }, [filters, query.q]);

  const refreshing = state.kind !== "loading" && state.key !== key;

  return (
    <>
      <PageHeader
        title="Wardrobe"
        actions={
          <form action="/api/auth/sign-out" method="post">
            <Button type="submit" variant="ghost" size="icon" aria-label="Sign out">
              <LogOutIcon className="size-5" aria-hidden="true" />
            </Button>
          </form>
        }
      />
      <PageBody className="space-y-4">
        <WardrobeFiltersBar value={filters} onChange={setFilters} />

        {state.kind === "loading" && <GridSkeleton />}

        {state.kind === "error" && (
          <ApiErrorNotice error={state.error}>
            <Button variant="outline" className="mt-2" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </Button>
          </ApiErrorNotice>
        )}

        {state.kind === "ready" && (
          <section aria-label="Your items" aria-busy={refreshing} className={refreshing ? "opacity-60 transition-opacity" : undefined}>
            <p className="text-muted-foreground mb-3 text-sm" aria-live="polite">
              {countLabel(state.items.length, state.filtered)}
            </p>
            {state.items.length === 0 ? (
              state.filtered ? (
                <div className="space-y-3 py-8 text-center">
                  <p className="font-medium">Nothing matches those filters.</p>
                  <Button variant="outline" onClick={() => setFilters(NO_FILTERS)}>
                    Clear filters
                  </Button>
                </div>
              ) : (
                <EmptyWardrobe />
              )
            ) : (
              <ItemGrid items={state.items} />
            )}
          </section>
        )}
      </PageBody>
    </>
  );
}

function countLabel(count: number, filtered: boolean): string {
  const items = count === 1 ? "1 item" : `${count} items`;
  return filtered ? `${items} match` : items;
}

function ItemGrid({ items }: { items: WardrobeItem[] }) {
  return (
    <ul className="grid grid-cols-3 gap-x-2 gap-y-3">
      {items.map((item, index) => (
        <li key={item.id}>
          <Link
            href={`/wardrobe/${item.id}`}
            className="focus-visible:ring-ring/50 block rounded-lg outline-none focus-visible:ring-[3px]"
          >
            <ItemImage item={item} alt="" priority={index < 9} />
            <span className="mt-1 line-clamp-2 text-xs leading-snug">{item.tags.description}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function EmptyWardrobe() {
  return (
    <div className="space-y-4 rounded-lg border border-dashed px-6 py-10 text-center">
      <div className="space-y-1">
        <p className="font-medium">Your wardrobe is empty</p>
        <p className="text-muted-foreground text-sm">Photograph an item or paste a product link to get started.</p>
      </div>
      <Button asChild size="lg" className="w-full">
        <Link href="/add">
          <PlusIcon aria-hidden="true" />
          Add your first item
        </Link>
      </Button>
    </div>
  );
}

function GridSkeleton() {
  return (
    <div className="grid grid-cols-3 gap-2" aria-label="Loading your wardrobe" role="status">
      {Array.from({ length: 9 }, (_, i) => (
        <Skeleton key={i} className="aspect-square rounded-lg" />
      ))}
    </div>
  );
}
