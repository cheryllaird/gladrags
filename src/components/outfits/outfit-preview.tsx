"use client";

import { useRef, useState } from "react";
import { DownloadIcon, ImageIcon, LayoutGridIcon, LoaderCircleIcon, RefreshCwIcon, SparklesIcon } from "lucide-react";
import type { Outfit } from "@/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { canvasToPng, loadImage, saveImageBlob } from "./collage-draw";
import { OutfitCollage } from "./outfit-collage";
import { canAskForPicture } from "./preview-runner";
import { previewView, suggestedPieces, type PreviewActivity, type PreviewNote } from "./preview-view";

interface OutfitPreviewProps {
  outfit: Outfit;
  activity: PreviewActivity;
  /** "Update preview" on an outdated picture. Hidden without it. */
  onUpdatePreview?: () => void;
  /**
   * "See it worn" (saved list): ask for this outfit's picture. Offered when
   * it has none yet but could; it counts against the daily picture cap.
   */
  onSeeItWorn?: () => void;
  /** Draw the collage only near the screen (long lists). */
  lazyCollage?: boolean;
  onReloadPictures?: () => Promise<void>;
}

/** The generated picture as a PNG, for "Save image". */
async function pictureToPng(url: string): Promise<Blob> {
  const img = await loadImage(url);
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth || 512;
  canvas.height = img.naturalHeight || 768;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("No canvas");
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  try {
    return await canvasToPng(canvas);
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

/**
 * An outfit's picture: the generated "wearing it" image when it's ready,
 * otherwise the collage (the placeholder while it's made, and the
 * fallback when it can't be). See preview-view.ts for which is shown.
 *
 * Progress ("Making picture 2 of 4", "Updating…") is announced once for
 * the whole screen by PreviewAnnouncer, not by each card.
 */
export function OutfitPreviewPanel(props: OutfitPreviewProps) {
  const { outfit, activity } = props;
  const view = previewView(outfit.preview, activity);
  const [showPieces, setShowPieces] = useState(false);
  /** The picture URL that failed to load (an expired link, say); a fresh URL gets a fresh try. */
  const [brokenUrl, setBrokenUrl] = useState<string | null>(null);

  const imageUrl = view.kind === "image" ? view.imageUrl : null;
  const pictureShown = view.kind === "image" && brokenUrl !== imageUrl;
  const pieces = suggestedPieces(outfit.preview.suggestedSlots, outfit.gaps);
  const refused = activity.problem?.kind === "daily_cap" || activity.problem?.kind === "paused";
  const offerSeeItWorn = props.onSeeItWorn && view.kind === "collage" && !refused && canAskForPicture(outfit);

  return (
    <div
      className="space-y-2"
      data-testid="outfit-preview"
      data-state={pictureShown ? "ready" : view.kind === "making" ? "making" : "collage"}
      data-reason={view.kind === "collage" ? (view.reason ?? "none") : undefined}
    >
      {view.kind === "making" && <MakingNotice awaitingPreset={view.awaitingPreset} />}

      {pictureShown && !showPieces ? (
        <div className="relative">
          {/* Signed storage URLs change hourly, so next/image's optimiser can't cache them. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            key={imageUrl}
            src={imageUrl!}
            alt={`${outfit.name}, worn by your model${pieces.length ? ` (${pieces.map((p) => p.label).join(", ").toLowerCase()})` : ""}`}
            crossOrigin="anonymous"
            data-testid="preview-image"
            onError={() => setBrokenUrl(imageUrl)}
            className="bg-muted aspect-[2/3] w-full rounded-lg object-contain"
          />
          {view.refreshing && (
            <Badge className="absolute top-2 left-2" data-testid="preview-updating">
              <LoaderCircleIcon aria-hidden className="animate-spin" />
              Updating…
            </Badge>
          )}
        </div>
      ) : (
        <OutfitCollage
          name={outfit.name}
          items={outfit.items}
          gaps={outfit.gaps}
          lazy={props.lazyCollage}
          onReloadPictures={props.onReloadPictures}
          // With a picture ready, "Save image" below saves the picture.
          hideSave={pictureShown}
        />
      )}

      {view.kind === "image" && !pictureShown && (
        <PreviewNoteBox
          note={{ title: "Couldn't load the picture", message: "Here are the pieces laid out instead." }}
          action={
            props.onReloadPictures ? (
              <Button type="button" variant="outline" onClick={() => void props.onReloadPictures?.()}>
                <RefreshCwIcon aria-hidden />
                Reload picture
              </Button>
            ) : null
          }
        />
      )}

      {pictureShown && pieces.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Suggested pieces, not from your wardrobe" data-testid="suggested-labels">
          {pieces.map((piece) => (
            <li key={piece.slot}>
              <Badge variant="outline" className="border-dashed">
                <SparklesIcon aria-hidden />
                {piece.label}
              </Badge>
            </li>
          ))}
        </ul>
      )}

      {view.kind === "image" && pictureShown && (
        <PictureControls
          outfitName={outfit.name}
          imageUrl={view.imageUrl}
          showPieces={showPieces}
          onTogglePieces={() => setShowPieces((s) => !s)}
          outdated={view.outdated}
          refreshing={view.refreshing}
          onUpdatePreview={props.onUpdatePreview}
        />
      )}

      {view.kind === "image" && view.note && <PreviewNoteBox note={view.note} />}
      {view.kind === "collage" && view.note && <PreviewNoteBox note={view.note} />}

      {offerSeeItWorn && (
        <Button type="button" variant="outline" className="w-full" onClick={props.onSeeItWorn}>
          <SparklesIcon aria-hidden />
          See it worn
        </Button>
      )}
    </div>
  );
}

function MakingNotice({ awaitingPreset }: { awaitingPreset: boolean }) {
  return (
    <p className="flex min-h-11 items-center gap-2 text-sm font-medium" data-testid="preview-making">
      {awaitingPreset ? (
        <>
          <ImageIcon aria-hidden className="text-muted-foreground size-4 shrink-0" />
          Pick your model to see this outfit worn.
        </>
      ) : (
        <>
          <LoaderCircleIcon aria-hidden className="text-muted-foreground size-4 shrink-0 animate-spin" />
          Dressing your model…
        </>
      )}
    </p>
  );
}

function PreviewNoteBox({ note, action }: { note: PreviewNote; action?: React.ReactNode }) {
  return (
    <div className="bg-muted/50 space-y-1 rounded-lg border p-3" data-testid="preview-note">
      <p className="text-sm font-medium">{note.title}</p>
      <p className="text-muted-foreground text-sm">{note.message}</p>
      {action}
    </div>
  );
}

function PictureControls(props: {
  outfitName: string;
  imageUrl: string;
  showPieces: boolean;
  onTogglePieces: () => void;
  outdated: boolean;
  refreshing: boolean;
  onUpdatePreview?: () => void;
}) {
  const { imageUrl, outfitName } = props;
  /**
   * The PNG, started on the first sign the user is about to tap (pointer
   * down, focus or hover) rather than for every picture on the screen, so
   * it's usually ready by the click and the share sheet opens inside the tap.
   */
  const pngRef = useRef<{ url: string; png: Promise<Blob>; ready: Blob | null } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  function prepare(): Promise<Blob> {
    const current = pngRef.current;
    if (current?.url === imageUrl) return current.png;
    const entry: { url: string; png: Promise<Blob>; ready: Blob | null } = { url: imageUrl, png: pictureToPng(imageUrl), ready: null };
    entry.png.then(
      (blob) => {
        entry.ready = blob;
      },
      () => {
        // A failed attempt is tried again on the next tap.
        if (pngRef.current === entry) pngRef.current = null;
      },
    );
    pngRef.current = entry;
    return entry.png;
  }

  function handleSave() {
    setSaving(true);
    setSaveMessage(null);
    const current = pngRef.current;
    const ready = current?.url === imageUrl ? current.ready : null;
    // Nothing is awaited before sharing when the PNG is ready (see saveImageBlob).
    const save = ready ? saveImageBlob(ready, outfitName) : prepare().then((png) => saveImageBlob(png, outfitName));
    save
      .then((result) => {
        if (result === "downloaded") setSaveMessage("Image saved to your downloads.");
      })
      .catch(() => setSaveMessage("Couldn't save this image. Try again, or take a screenshot instead."))
      .finally(() => setSaving(false));
  }

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center justify-between gap-1">
        <Button type="button" variant="ghost" aria-pressed={props.showPieces} onClick={props.onTogglePieces}>
          <LayoutGridIcon aria-hidden />
          Show the pieces
        </Button>
        <div className="flex gap-1">
          {/* While refreshing, the "Updating…" badge on the picture says so. */}
          {props.outdated && !props.refreshing && props.onUpdatePreview && (
            <Button type="button" variant="outline" onClick={props.onUpdatePreview}>
              <RefreshCwIcon aria-hidden />
              Update preview
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            onClick={handleSave}
            onPointerDown={() => void prepare().catch(() => {})}
            onPointerEnter={() => void prepare().catch(() => {})}
            onFocus={() => void prepare().catch(() => {})}
            disabled={saving}
            aria-label={`Save image of ${outfitName}`}
          >
            <DownloadIcon aria-hidden />
            Save image
          </Button>
        </div>
      </div>
      {props.outdated && !props.refreshing && (
        <p className="text-muted-foreground text-xs">You&apos;ve changed a suggested piece since this picture was made.</p>
      )}
      <p className="text-muted-foreground min-h-5 text-xs" aria-live="polite">
        {saveMessage ?? ""}
      </p>
    </div>
  );
}
