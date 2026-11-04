"use client";

import { InfoIcon } from "lucide-react";
import { useState } from "react";
import type { ItemDraft, ItemTags, WardrobeItem } from "@/contracts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ApiClientError, createItem } from "@/lib/client/api";
import { ApiErrorNotice } from "../api-error-notice";
import { ItemImage } from "../item-image";
import { TagForm } from "../tag-form";
import { tagsWereEdited } from "../tag-form-values";
import { keepDraft } from "./pending-add";

/**
 * Step 5 of adding an item (spec: Add by photo): the photo and the
 * pre-filled tags, all editable, then save with POST /api/items. Also how
 * the review list fills in a batch draft whose tagging failed.
 */
export function DraftReview({
  userId,
  draft,
  restoredTags = null,
  onSaved,
  onDiscard,
  onImageError,
}: {
  /** The signed-in user, so a draft kept on sign-out is only restored for them (see pending-add.ts). */
  userId: string | null;
  draft: ItemDraft;
  /** Tags the user had chosen before being signed out (see pending-add.ts). */
  restoredTags?: ItemTags | null;
  onSaved: (item: WardrobeItem) => void;
  onDiscard: () => void;
  /** The draft's picture didn't load (its signed URL may have expired; drafts can't be re-signed). */
  onImageError?: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function save(tags: ItemTags) {
    setSaving(true);
    setError(null);
    try {
      const item = await createItem({
        source: draft.source,
        sourceUrl: draft.sourceUrl,
        originalImageKey: draft.originalImageKey,
        cutoutImageKey: draft.cutoutImageKey,
        tags,
        // Against the model's suggestion, even when the form started from restored tags.
        tagsEdited: tagsWereEdited(draft.suggestedTags, tags),
      });
      onSaved(item);
    } catch (err) {
      // Signed out: the API client is taking them to sign-in. Keep the item
      // so /add can reopen this review afterwards.
      if (err instanceof ApiClientError && err.code === "unauthorized") keepDraft(userId, draft, tags);
      setError(err);
      setSaving(false);
    }
  }

  return (
    <div className="space-y-5">
      <ItemImage item={draft} alt="The item you're adding" priority className="mx-auto w-full max-w-48" onError={onImageError} />

      {draft.suggestedTags === null ? (
        <Alert>
          <InfoIcon />
          <AlertTitle>Fill in the tags</AlertTitle>
          <AlertDescription>We couldn&apos;t tag this one automatically. Choose the tags below, then save.</AlertDescription>
        </Alert>
      ) : (
        <p className="text-muted-foreground text-sm">Check the tags and fix anything that&apos;s wrong, then save.</p>
      )}

      {error !== null && <ApiErrorNotice error={error} />}

      <TagForm
        initialTags={restoredTags ?? draft.suggestedTags}
        submitLabel="Save to wardrobe"
        busyLabel="Saving…"
        busy={saving}
        onSubmit={(tags) => void save(tags)}
        onCancel={onDiscard}
        cancelLabel="Discard"
      />
    </div>
  );
}
