"use client";

import { ImagePlusIcon, Loader2Icon } from "lucide-react";
import { useRef, useState } from "react";
import type { WardrobeItem } from "@/contracts";
import { Button } from "@/components/ui/button";
import { replaceItemPhoto } from "@/lib/client/api";
import { prepareOriginal, renameWithExtension } from "@/lib/client/photo";

/**
 * "Add a photo" for an item that came from an order email without a
 * usable picture (needsPhoto). The photo is resized and re-encoded like
 * any other (HEIC included), then sent with PUT /api/items/:id/photo. The
 * tags stay; the item goes back to "to review" so they can be checked
 * against the photo.
 */
export function AddPhotoButton({
  itemId,
  onAdded,
  onError,
  className,
  accessibleName,
}: {
  itemId: string;
  /** A fuller name for screen readers when there are several on a page; it starts with the visible text. */
  accessibleName?: string;
  onAdded: (item: WardrobeItem) => void;
  onError: (error: unknown) => void;
  className?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  async function upload(file: File) {
    setBusy(true);
    try {
      const blob = await prepareOriginal(file);
      onAdded(await replaceItemPhoto(itemId, { blob, name: renameWithExtension(file.name || "photo", "jpg") }));
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button type="button" variant="outline" size="lg" className={className}
        disabled={busy}
        aria-label={busy ? undefined : accessibleName}
        onClick={() => ref.current?.click()}
      >
        {busy ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : <ImagePlusIcon aria-hidden="true" />}
        {busy ? "Adding the photo…" : "Add a photo"}
      </Button>
      <input
        ref={ref}
        type="file"
        accept="image/*"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        data-testid="add-photo-input"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void upload(file);
        }}
      />
    </>
  );
}
