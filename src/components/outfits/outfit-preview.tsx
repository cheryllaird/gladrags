"use client";

import { useEffect, useRef, useState } from "react";
import { DownloadIcon, ImageIcon, LayoutGridIcon, LoaderCircleIcon, RefreshCwIcon, SparklesIcon } from "lucide-react";
import type { Outfit } from "@/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { canvasToPng, loadImage, saveImageBlob } from "./collage-draw";
import { OutfitCollage } from "./outfit-collage";
import { previewView, suggestedLabels, type PreviewActivity, type PreviewNote } from "./preview-view";

interface OutfitPreviewProps {
  outfit: Outfit;
  activity: PreviewActivity;
  /** "Update preview" on an outdated picture. Hidden without it. */
  onUpdatePreview?: () => void;
  /** Called once when the panel comes near the screen (saved list: ask for pictures as they're reached). */
  onNear?: () => void;
  /** Draw the collage only near the screen (long lists). */
  lazyCollage?: boolean;
  onReloadPictures?: () => Promise<void>;
}

/** The generated picture as a PNG, so "Save image" can share it straight from the tap. */
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
 */
export function OutfitPreviewPanel(props: OutfitPreviewProps) {
  const { outfit, activity } = props;
  const view = previewView(outfit.preview, activity);
  const rootRef = useRef<HTMLDivElement>(null);
  const [showPieces, setShowPieces] = useState(false);
  /** The picture URL that failed to load (an expired link, say); a fresh URL gets a fresh try. */
  const [brokenUrl, setBrokenUrl] = useState<string | null>(null);

  // Saved list: ask for this outfit's picture once it's within a screen or so.
  // A ref, so a new callback each render doesn't start a new observer.
  const onNearRef = useRef(props.onNear);
  useEffect(() => {
    onNearRef.current = props.onNear;
  }, [props.onNear]);
  const wantsNear = props.onNear !== undefined;
  useEffect(() => {
    if (!wantsNear) return;
    const onNear = () => onNearRef.current?.();
    const el = rootRef.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      onNear();
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          observer.disconnect();
          onNear();
        }
      },
      { rootMargin: "800px 0px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [wantsNear]);

  const imageUrl = view.kind === "image" ? view.imageUrl : null;
  const pictureShown = view.kind === "image" && brokenUrl !== imageUrl;
  const labels = suggestedLabels(outfit.preview.suggestedSlots, outfit.gaps);

  return (
    <div
      ref={rootRef}
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
            alt={`${outfit.name}, worn by your model${labels.length ? ` (${labels.join(", ").toLowerCase()})` : ""}`}
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

      {pictureShown && labels.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Suggested pieces, not from your wardrobe" data-testid="suggested-labels">
          {labels.map((label) => (
            <li key={label}>
              <Badge variant="outline" className="border-dashed">
                <SparklesIcon aria-hidden />
                {label}
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
    </div>
  );
}

function MakingNotice({ awaitingPreset }: { awaitingPreset: boolean }) {
  return (
    <p role="status" className="flex min-h-11 items-center gap-2 text-sm font-medium" data-testid="preview-making">
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
  const pngRef = useRef<{ url: string; png: Blob } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  // Make the PNG ahead, so the share sheet can open inside the tap.
  useEffect(() => {
    let cancelled = false;
    pictureToPng(imageUrl).then(
      (png) => {
        if (!cancelled) pngRef.current = { url: imageUrl, png };
      },
      () => {
        // Saving will try again, and say so if it still can't.
      },
    );
    return () => {
      cancelled = true;
    };
  }, [imageUrl]);

  function handleSave() {
    setSaving(true);
    setSaveMessage(null);
    const ready = pngRef.current?.url === imageUrl ? pngRef.current.png : null;
    const save = ready ? saveImageBlob(ready, outfitName) : pictureToPng(imageUrl).then((png) => saveImageBlob(png, outfitName));
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
          {props.showPieces ? <ImageIcon aria-hidden /> : <LayoutGridIcon aria-hidden />}
          {props.showPieces ? "Show the picture" : "Show the pieces"}
        </Button>
        <div className="flex gap-1">
          {/* While refreshing, the "Updating…" badge on the picture says so. */}
          {props.outdated && !props.refreshing && props.onUpdatePreview && (
            <Button type="button" variant="outline" onClick={props.onUpdatePreview}>
              <RefreshCwIcon aria-hidden />
              Update preview
            </Button>
          )}
          <Button type="button" variant="ghost" onClick={handleSave} disabled={saving} aria-label={`Save image of ${outfitName}`}>
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
