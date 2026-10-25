"use client";

import { InfoIcon } from "lucide-react";
import { useState } from "react";
import type { ItemDraft, ItemTags, WardrobeItem } from "@/contracts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { createItem } from "@/lib/client/api";
import { ApiErrorNotice } from "../api-error-notice";
import { ItemImage } from "../item-image";
import { TagForm } from "../tag-form";

/**
 * Step 5 of adding an item (spec: Add by photo): the cut-out and the
 * pre-filled tags, all editable, then save with POST /api/items.
 */
export function DraftReview({
  draft,
  cutoutFailed,
  onSaved,
  onDiscard,
}: {
  draft: ItemDraft;
  cutoutFailed: boolean;
  onSaved: (item: WardrobeItem) => void;
  onDiscard: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function save(tags: ItemTags, edited: boolean) {
    setSaving(true);
    setError(null);
    try {
      const item = await createItem({
        source: draft.source,
        sourceUrl: draft.sourceUrl,
        originalImageKey: draft.originalImageKey,
        cutoutImageKey: draft.cutoutImageKey,
        tags,
        tagsEdited: edited,
      });
      onSaved(item);
    } catch (err) {
      setError(err);
      setSaving(false);
    }
  }

  const noCutout = draft.cutoutUrl === null;

  return (
    <div className="space-y-5">
      <ItemImage item={draft} alt="The item you're adding" priority className="mx-auto w-full max-w-48" />

      {noCutout && (
        <p className="text-muted-foreground text-center text-sm">
          {cutoutFailed
            ? "We couldn't cut this one out on your phone, so the original photo will be used."
            : "No cut-out for this one, so the original image will be used."}
        </p>
      )}

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
        initialTags={draft.suggestedTags}
        submitLabel="Save to wardrobe"
        busyLabel="Saving…"
        busy={saving}
        onSubmit={(tags, edited) => void save(tags, edited)}
        onCancel={onDiscard}
        cancelLabel="Discard"
      />
    </div>
  );
}
