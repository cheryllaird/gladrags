"use client";

import { CheckCheckIcon, CheckIcon, ChevronLeftIcon, ImageOffIcon, PencilIcon, PencilLineIcon, Trash2Icon } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import type { ItemDraft, ItemTags, WardrobeItem } from "@/contracts";
import { PageBody, PageHeader } from "@/components/app-shell/page-header";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiErrorNotice } from "@/components/wardrobe/api-error-notice";
import { DraftReview } from "@/components/wardrobe/add/draft-review";
import { ItemImage } from "@/components/wardrobe/item-image";
import { COLOUR_LABELS, categoryLine } from "@/components/wardrobe/labels";
import { AddPhotoButton } from "@/components/wardrobe/review/add-photo-button";
import { BATCH_DRAFTS_KEY, batchDraftsFromRaw, removeBatchDraft } from "@/components/wardrobe/review/batch-drafts";
import { StickyActions } from "@/components/wardrobe/sticky-actions";
import { TagForm } from "@/components/wardrobe/tag-form";
import { useSignedUrlRefresh } from "@/components/wardrobe/use-signed-url-refresh";
import { listItems, markItemReviewed, markItemsReviewed, updateItemTags } from "@/lib/client/api";
import { useStorageValue } from "@/lib/client/use-storage-value";

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; items: WardrobeItem[]; loadedAt: number }
  | { kind: "error"; error: unknown };

type Editing = { kind: "item"; item: WardrobeItem } | { kind: "draft"; draft: ItemDraft } | null;

/**
 * Confirm or correct the tags of items added in a batch, one by one or
 * all at once, fill in drafts whose tagging failed, and add a photo to
 * email items that came without one.
 */
export function ReviewScreen({ userId }: { userId: string | null }) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  // Drafts live in this tab's storage, so they're read after hydration.
  const drafts = batchDraftsFromRaw(useStorageValue("session", BATCH_DRAFTS_KEY), userId);
  const [editing, setEditing] = useState<Editing>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmingAll, setConfirmingAll] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Drafts whose picture failed to load: their signed URL expired, and a draft can't be re-signed.
  const [expired, setExpired] = useState<ReadonlySet<string>>(new Set());
  const markExpired = (draft: ItemDraft) => setExpired((current) => new Set(current).add(draft.originalImageKey));

  const reload = () => setAttempt((n) => n + 1);
  const { onImageError } = useSignedUrlRefresh({
    loadKey: state.kind === "ready" ? String(state.loadedAt) : null,
    loadedAt: state.kind === "ready" ? state.loadedAt : null,
    refresh: reload,
  });

  useEffect(() => {
    let current = true;
    listItems({ needsReview: true }).then(
      (items) => current && setState({ kind: "ready", items, loadedAt: Date.now() }),
      (error: unknown) => current && setState({ kind: "error", error }),
    );
    return () => {
      current = false;
    };
  }, [attempt]);

  function go(next: Editing) {
    setEditing(next);
    setActionError(null);
    window.scrollTo({ top: 0 });
  }

  function dropItem(id: string) {
    setState((s) => (s.kind === "ready" ? { ...s, items: s.items.filter((item) => item.id !== id) } : s));
  }

  function replaceItem(updated: WardrobeItem) {
    setState((s) => (s.kind === "ready" ? { ...s, items: s.items.map((item) => (item.id === updated.id ? updated : item)) } : s));
  }

  function dropDraft(draft: ItemDraft) {
    removeBatchDraft(userId, draft.originalImageKey);
  }

  async function confirm(item: WardrobeItem) {
    setActionError(null);
    setNotice(null);
    setBusyId(item.id);
    try {
      await markItemReviewed(item.id);
      dropItem(item.id);
      setNotice(`Confirmed: ${item.tags.description}`);
    } catch (error) {
      setActionError(error);
    } finally {
      setBusyId(null);
    }
  }

  async function saveEdit(item: WardrobeItem, tags: ItemTags, edited: boolean) {
    setActionError(null);
    setBusyId(item.id);
    try {
      // Unchanged tags just confirm them; any PATCH clears "to review".
      if (edited) await updateItemTags(item.id, tags);
      else await markItemReviewed(item.id);
      dropItem(item.id);
      setNotice(`${edited ? "Saved" : "Confirmed"}: ${tags.description}`);
      go(null);
    } catch (error) {
      setActionError(error);
    } finally {
      setBusyId(null);
    }
  }

  async function confirmAll(items: WardrobeItem[]) {
    setActionError(null);
    setNotice(null);
    setConfirmingAll(true);
    const dropConfirmed = (ids: readonly string[]) => {
      const confirmed = new Set(ids);
      setState((s) => (s.kind === "ready" ? { ...s, items: s.items.filter((item) => !confirmed.has(item.id)) } : s));
    };
    try {
      // Each chunk the server confirms leaves the list at once, so a later failure only leaves the rest.
      await markItemsReviewed(
        items.map((item) => item.id),
        dropConfirmed,
      );
      setNotice(items.length === 1 ? "Confirmed 1 item." : `Confirmed all ${items.length} items.`);
      window.scrollTo({ top: 0 });
    } catch (error) {
      setActionError(error);
    } finally {
      setConfirmingAll(false);
    }
  }

  if (editing?.kind === "item") {
    const { item } = editing;
    return (
      <>
        <PageHeader title="Edit tags" />
        <PageBody className="space-y-5">
          <BackToList onClick={() => go(null)} />
          <ItemImage item={item} alt={item.tags.description} className="mx-auto w-full max-w-48" onError={onImageError} />
          {actionError !== null && <ApiErrorNotice error={actionError} />}
          <TagForm
            initialTags={item.tags}
            submitLabel="Save tags"
            busyLabel="Saving…"
            busy={busyId === item.id}
            onSubmit={(tags, edited) => void saveEdit(item, tags, edited)}
            onCancel={() => go(null)}
          />
        </PageBody>
      </>
    );
  }

  if (editing?.kind === "draft") {
    const { draft } = editing;
    return (
      <>
        <PageHeader title="Fill in the tags" />
        <PageBody className="space-y-5">
          <BackToList onClick={() => go(null)} />
          <DraftReview
            userId={userId}
            draft={draft}
            onSaved={(item) => {
              dropDraft(draft);
              setNotice(`Saved: ${item.tags.description}`);
              go(null);
            }}
            onDiscard={() => {
              dropDraft(draft);
              setNotice("Discarded.");
              go(null);
            }}
            onImageError={() => {
              markExpired(draft);
              go(null);
            }}
          />
        </PageBody>
      </>
    );
  }

  const items = state.kind === "ready" ? state.items : [];
  const nothingLeft = state.kind === "ready" && items.length === 0 && drafts.length === 0;

  return (
    <>
      <PageHeader title="Review new items" backHref="/wardrobe" backLabel="Back to wardrobe" />
      <PageBody className="space-y-5">
        {notice && (
          <p role="status" className="bg-muted rounded-md px-3 py-2 text-sm">
            {notice}
          </p>
        )}
        {actionError !== null && <ApiErrorNotice error={actionError} />}

        {state.kind === "loading" && (
          <div role="status" aria-label="Loading items to review" className="space-y-3">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="h-28 w-full rounded-lg" />
            ))}
          </div>
        )}

        {state.kind === "error" && (
          <ApiErrorNotice error={state.error}>
            <Button variant="outline" className="mt-2" onClick={reload}>
              Try again
            </Button>
          </ApiErrorNotice>
        )}

        {nothingLeft && (
          <div className="space-y-4 rounded-lg border border-dashed px-6 py-10 text-center">
            <div className="space-y-1">
              <p className="font-medium">All caught up</p>
              <p className="text-muted-foreground text-sm">There&apos;s nothing left to review.</p>
            </div>
            <Button asChild size="lg" className="w-full">
              <Link href="/wardrobe">Back to wardrobe</Link>
            </Button>
          </div>
        )}

        {!nothingLeft && state.kind !== "loading" && (
          <p className="text-muted-foreground text-sm">
            We filled in the tags for you. Confirm the ones that look right, or edit them. Items you haven&apos;t reviewed are
            still used for outfits.
          </p>
        )}

        {drafts.length > 0 && (
          <section aria-labelledby="drafts-heading" className="space-y-3">
            <h2 id="drafts-heading" className="font-semibold">
              Need tags ({drafts.length})
            </h2>
            <p className="text-muted-foreground text-sm">
              We couldn&apos;t tag these automatically, so they aren&apos;t in your wardrobe yet. Fill in the tags to save them.
            </p>
            <ul className="space-y-3">
              {drafts.map((draft, index) =>
                expired.has(draft.originalImageKey) ? (
                  <li key={draft.originalImageKey} aria-label={`Item without tags ${index + 1}`} className="flex items-center gap-3 rounded-lg border p-3">
                    <div className="bg-muted flex aspect-square w-20 shrink-0 items-center justify-center rounded-lg">
                      <ImageOffIcon className="text-muted-foreground size-6" aria-hidden="true" />
                    </div>
                    <div className="min-w-0 flex-1 space-y-2">
                      <p className="text-sm">This photo has expired. Discard it and add the photo again.</p>
                      <Button
                        size="lg"
                        variant="outline"
                        className="w-full"
                        aria-label={`Discard expired item ${index + 1}`}
                        onClick={() => {
                          dropDraft(draft);
                          setNotice("Discarded.");
                        }}
                      >
                        <Trash2Icon aria-hidden="true" />
                        Discard
                      </Button>
                    </div>
                  </li>
                ) : (
                  <li key={draft.originalImageKey} aria-label={`Item without tags ${index + 1}`} className="flex items-center gap-3 rounded-lg border p-3">
                    <ItemImage item={draft} alt="" className="w-20 shrink-0" onError={() => markExpired(draft)} />
                    <Button size="lg" variant="outline" className="flex-1" onClick={() => go({ kind: "draft", draft })}>
                      <PencilLineIcon aria-hidden="true" />
                      Fill in tags
                    </Button>
                  </li>
                ),
              )}
            </ul>
          </section>
        )}

        {items.length > 0 && (
          <section aria-labelledby="items-heading" className="space-y-3">
            <h2 id="items-heading" className="font-semibold">
              To review ({items.length})
            </h2>
            <ul className="space-y-3">
              {items.map((item) => (
                <ReviewCard
                  key={item.id}
                  item={item}
                  busy={busyId === item.id || confirmingAll}
                  onConfirm={() => void confirm(item)}
                  onEdit={() => go({ kind: "item", item })}
                  onPhotoAdded={(updated) => {
                    replaceItem(updated);
                    setNotice("Photo added. Check the tags still match it.");
                  }}
                  onError={setActionError}
                  onImageError={onImageError}
                />
              ))}
            </ul>
          </section>
        )}

        {items.length > 1 && (
          <StickyActions>
            <Button size="lg" className="flex-1" disabled={confirmingAll} onClick={() => void confirmAll(items)}>
              <CheckCheckIcon aria-hidden="true" />
              {confirmingAll ? "Confirming…" : `Confirm all ${items.length}`}
            </Button>
          </StickyActions>
        )}
      </PageBody>
    </>
  );
}

function BackToList({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="ghost" className="-ml-2" onClick={onClick}>
      <ChevronLeftIcon aria-hidden="true" />
      Back to the list
    </Button>
  );
}

function ReviewCard({
  item,
  busy,
  onConfirm,
  onEdit,
  onPhotoAdded,
  onError,
  onImageError,
}: {
  item: WardrobeItem;
  busy: boolean;
  onConfirm: () => void;
  onEdit: () => void;
  onPhotoAdded: (item: WardrobeItem) => void;
  onError: (error: unknown) => void;
  onImageError: () => void;
}) {
  const { tags } = item;
  return (
    <li aria-label={tags.description} className="space-y-3 rounded-lg border p-3">
      <div className="flex gap-3">
        <ItemImage item={item} alt="" className="w-20 shrink-0" onError={onImageError} />
        <div className="min-w-0 flex-1 space-y-0.5">
          <p className="line-clamp-2 font-medium">{tags.description}</p>
          <p className="text-muted-foreground text-sm">{categoryLine(tags)}</p>
          <p className="text-muted-foreground text-sm">{tags.colours.map((c) => COLOUR_LABELS[c]).join(", ")}</p>
          {item.source === "email" && <p className="text-muted-foreground text-xs">From an order email</p>}
        </div>
      </div>
      {item.needsPhoto && (
        <div className="space-y-2">
          <p className="text-muted-foreground flex items-center gap-2 text-sm">
            <ImageOffIcon className="size-4 shrink-0" aria-hidden="true" />
            No picture came with this one.
          </p>
          <AddPhotoButton itemId={item.id} onAdded={onPhotoAdded} onError={onError} className="w-full" />
        </div>
      )}
      <div className="grid grid-cols-2 gap-2">
        <Button variant="outline" size="lg" disabled={busy} onClick={onEdit}>
          <PencilIcon aria-hidden="true" />
          Edit tags
        </Button>
        <Button size="lg" disabled={busy} onClick={onConfirm}>
          <CheckIcon aria-hidden="true" />
          Looks right
        </Button>
      </div>
    </li>
  );
}
