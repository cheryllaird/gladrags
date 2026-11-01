"use client";

import { CheckIcon, ExternalLinkIcon, ImageOffIcon, PencilIcon, SparklesIcon, Trash2Icon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { ItemTags, WardrobeItem } from "@/contracts";
import { PageBody, PageHeader } from "@/components/app-shell/page-header";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiErrorNotice } from "@/components/wardrobe/api-error-notice";
import { ItemImage } from "@/components/wardrobe/item-image";
import {
  COLOUR_LABELS,
  formalityLabel,
  OCCASION_LABELS,
  PATTERN_LABELS,
  SEASON_LABELS,
  WARMTH_LABELS,
  categoryLine,
} from "@/components/wardrobe/labels";
import { AddPhotoButton } from "@/components/wardrobe/review/add-photo-button";
import { StickyActions } from "@/components/wardrobe/sticky-actions";
import { TagForm } from "@/components/wardrobe/tag-form";
import { useSignedUrlRefresh } from "@/components/wardrobe/use-signed-url-refresh";
import { wardrobeReturnPath } from "@/components/wardrobe/wardrobe-return";
import { ApiClientError, deleteItem, getItem, markItemReviewed, updateItemTags } from "@/lib/client/api";

type State =
  | { kind: "loading" }
  | { kind: "ready"; item: WardrobeItem; loadedAt: number }
  | { kind: "error"; error: unknown };

export function ItemDetailScreen({ id }: { id: string }) {
  const router = useRouter();
  const [state, setState] = useState<State>({ kind: "loading" });
  // Bumped to fetch the item again (Retry, or fresh signed image URLs).
  const [attempt, setAttempt] = useState(0);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = () => setAttempt((n) => n + 1);
  const { onImageError } = useSignedUrlRefresh({
    loadKey: state.kind === "ready" ? String(state.loadedAt) : null,
    loadedAt: state.kind === "ready" ? state.loadedAt : null,
    refresh: reload,
  });

  useEffect(() => {
    let current = true;
    getItem(id).then(
      (item) => current && setState({ kind: "ready", item, loadedAt: Date.now() }),
      (error: unknown) => current && setState({ kind: "error", error }),
    );
    return () => {
      current = false;
    };
  }, [id, attempt]);

  async function save(item: WardrobeItem, tags: ItemTags, edited: boolean) {
    setActionError(null);
    if (!edited) {
      setEditing(false);
      setNotice("No changes to save.");
      return;
    }
    setSaving(true);
    try {
      const updated = await updateItemTags(item.id, tags);
      setState({ kind: "ready", item: updated, loadedAt: Date.now() });
      setEditing(false);
      setNotice("Tags saved.");
      window.scrollTo({ top: 0 });
    } catch (error) {
      setActionError(error);
    } finally {
      setSaving(false);
    }
  }

  async function confirmTags(item: WardrobeItem) {
    setActionError(null);
    setSaving(true);
    try {
      const updated = await markItemReviewed(item.id);
      setState({ kind: "ready", item: updated, loadedAt: Date.now() });
      setNotice("Tags confirmed.");
    } catch (error) {
      setActionError(error);
    } finally {
      setSaving(false);
    }
  }

  async function remove(item: WardrobeItem) {
    setActionError(null);
    setDeleting(true);
    try {
      await deleteItem(item.id);
      // Back to the wardrobe as the user left it, filters included.
      router.replace(wardrobeReturnPath());
      router.refresh();
    } catch (error) {
      setActionError(error);
      setDeleting(false);
    }
  }

  const title = state.kind === "ready" ? (editing ? "Edit tags" : state.item.tags.description) : "Item";

  return (
    <>
      <PageHeader title={title} backHref="/wardrobe" backLabel="Back to wardrobe" />
      <PageBody className="space-y-5">
        {state.kind === "loading" && (
          <div role="status" aria-label="Loading item" className="space-y-4">
            <Skeleton className="aspect-square w-full rounded-lg" />
            <Skeleton className="h-6 w-2/3" />
          </div>
        )}

        {state.kind === "error" && (
          <ApiErrorNotice
            error={
              state.error instanceof ApiClientError && state.error.code === "not_found"
                ? new ApiClientError("not_found", "That item isn't in your wardrobe. It may have been deleted.")
                : state.error
            }
          >
            <div className="mt-2 flex flex-wrap gap-2">
              {!(state.error instanceof ApiClientError && state.error.code === "not_found") && (
                <Button
                  variant="outline"
                  onClick={() => {
                    setState({ kind: "loading" });
                    reload();
                  }}
                >
                  Try again
                </Button>
              )}
              <Button asChild variant="outline">
                <Link href="/wardrobe">Back to wardrobe</Link>
              </Button>
            </div>
          </ApiErrorNotice>
        )}

        {state.kind === "ready" && (
          <>
            <ItemImage
              // Keyed by load, so a refetch remounts the image with its new URL.
              key={state.loadedAt}
              item={state.item}
              alt={state.item.tags.description}
              priority
              onError={onImageError}
              className="mx-auto w-full max-w-64"
            />

            {state.item.needsPhoto && !editing && (
              <div className="space-y-2 rounded-lg border p-3">
                <p className="flex items-center gap-2 text-sm">
                  <ImageOffIcon className="size-4 shrink-0" aria-hidden="true" />
                  No picture came with this item. Add a photo of it so it shows in your wardrobe and outfits.
                </p>
                <AddPhotoButton
                  itemId={state.item.id}
                  className="w-full"
                  onAdded={(updated) => {
                    setState({ kind: "ready", item: updated, loadedAt: Date.now() });
                    setNotice("Photo added. Check the tags still match it.");
                  }}
                  onError={setActionError}
                />
              </div>
            )}

            {state.item.needsReview && !state.item.needsPhoto && !editing && (
              <div className="space-y-2 rounded-lg border p-3">
                <p className="text-sm">These tags were filled in for you and haven&apos;t been checked yet.</p>
                <Button variant="outline" size="lg" className="w-full" disabled={saving} onClick={() => void confirmTags(state.item)}>
                  <CheckIcon aria-hidden="true" />
                  Tags look right
                </Button>
              </div>
            )}

            {notice && !editing && (
              <p role="status" className="bg-muted rounded-md px-3 py-2 text-sm">
                {notice}
              </p>
            )}
            {actionError !== null && <ApiErrorNotice error={actionError} />}

            {editing ? (
              <TagForm
                initialTags={state.item.tags}
                submitLabel="Save tags"
                busy={saving}
                onSubmit={(tags, edited) => void save(state.item, tags, edited)}
                onCancel={() => {
                  setEditing(false);
                  setActionError(null);
                }}
              />
            ) : (
              <>
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    variant="outline"
                    onClick={() => {
                      setNotice(null);
                      setEditing(true);
                    }}
                  >
                    <PencilIcon aria-hidden="true" />
                    Edit tags
                  </Button>
                  <DeleteButton busy={deleting} onConfirm={() => void remove(state.item)} />
                </div>
                <TagSummary item={state.item} />
                <StickyActions>
                  <Button asChild size="lg" className="flex-1">
                    <Link href={`/outfits?anchor=${encodeURIComponent(state.item.id)}`}>
                      <SparklesIcon aria-hidden="true" />
                      Build an outfit around this
                    </Link>
                  </Button>
                </StickyActions>
              </>
            )}
          </>
        )}
      </PageBody>
    </>
  );
}

function TagSummary({ item }: { item: WardrobeItem }) {
  const { tags } = item;
  const rows: [string, string][] = [
    ["Type", categoryLine(tags)],
    ["Colours", tags.colours.map((c) => COLOUR_LABELS[c]).join(", ")],
    ["Pattern", PATTERN_LABELS[tags.pattern]],
    ["Formality", formalityLabel(tags.formality)],
    ["Seasons", tags.seasons.length === 4 ? "All year" : tags.seasons.map((s) => SEASON_LABELS[s]).join(", ")],
    ["Warmth", WARMTH_LABELS[tags.warmth]],
    ["Occasions", tags.occasions.map((o) => OCCASION_LABELS[o]).join(", ")],
    ["Fabric", tags.fabric ?? "Not set"],
  ];
  return (
    <section aria-label="Tags" className="space-y-3">
      <dl className="divide-y rounded-lg border">
        {rows.map(([label, value]) => (
          <div key={label} className="grid grid-cols-[6.5rem_1fr] gap-2 px-3 py-2.5 text-sm">
            <dt className="text-muted-foreground">{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {item.sourceUrl && (
        <a
          href={item.sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-muted-foreground inline-flex min-h-11 items-center gap-1 text-sm underline underline-offset-4"
        >
          <ExternalLinkIcon className="size-4" aria-hidden="true" />
          View the product page
        </a>
      )}
    </section>
  );
}

function DeleteButton({ busy, onConfirm }: { busy: boolean; onConfirm: () => void }) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="outline" className="text-destructive" disabled={busy}>
          <Trash2Icon aria-hidden="true" />
          {busy ? "Deleting…" : "Delete"}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this item?</AlertDialogTitle>
          <AlertDialogDescription>
            This removes it and its photos from your wardrobe, along with any outfits that use it, including saved ones.
            You can&apos;t undo this.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep it</AlertDialogCancel>
          <AlertDialogAction className="bg-destructive hover:bg-destructive/90 text-white" onClick={onConfirm}>
            Delete item
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
