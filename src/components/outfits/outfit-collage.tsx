"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { DownloadIcon, RefreshCwIcon } from "lucide-react";
import { displayImageUrl, type WardrobeItem } from "@/contracts";
import { Button } from "@/components/ui/button";
import { canvasToPng, drawCollage, loadImage, saveImageBlob } from "./collage-draw";
import { layoutCollage } from "./collage-layout";

/**
 * idle: waiting to come near the screen (lazy collages only)
 * loading: fetching pictures
 * ready: every item drawn
 * partial: drawn, but some items are placeholders (a picture didn't load)
 * error: the canvas couldn't be drawn at all
 */
type DrawState = "idle" | "loading" | "ready" | "partial" | "error";

interface OutfitCollageProps {
  name: string;
  items: readonly WardrobeItem[];
  /** Only load and draw once the collage is near the screen (long lists). */
  lazy?: boolean;
  /**
   * Fetch the outfit again for fresh image URLs. Offered as "Reload
   * pictures" when some pictures didn't load (e.g. their signed URLs expired).
   */
  onReloadPictures?: () => Promise<void>;
}

/**
 * An outfit's flat-lay collage, drawn on a canvas, with "Save image".
 * The canvas is drawn at full resolution and scaled down by CSS.
 */
export function OutfitCollage({ name, items, lazy = false, onReloadPictures }: OutfitCollageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  /** The finished collage as a PNG, made ahead so "Save image" can share straight from the tap. */
  const pngRef = useRef<Blob | null>(null);
  const [near, setNear] = useState(!lazy);
  const [drawState, setDrawState] = useState<DrawState>(lazy ? "idle" : "loading");
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [reloading, setReloading] = useState(false);

  const layout = useMemo(
    () =>
      layoutCollage(
        items.map((item) => ({
          id: item.id,
          category: item.tags.category,
          imageUrl: displayImageUrl(item),
          label: item.tags.description,
        })),
      ),
    [items],
  );

  // Lazy collages wait until they're within a screen or so of the viewport.
  useEffect(() => {
    if (near) return;
    const canvas = canvasRef.current;
    if (!canvas || typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setNear(true);
      },
      { rootMargin: "800px 0px" },
    );
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [near]);

  useEffect(() => {
    if (!near) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;

    async function draw(target: HTMLCanvasElement) {
      setDrawState("loading");
      pngRef.current = null;
      const results = await Promise.allSettled(layout.placed.map((p) => loadImage(p.imageUrl)));
      if (cancelled) return;
      const images = new Map<string, HTMLImageElement>();
      results.forEach((result, i) => {
        if (result.status === "fulfilled") images.set(layout.placed[i]!.id, result.value);
      });
      // Set the size here, not only in JSX: unmounting frees the canvas by
      // shrinking it to 0, and a remount (e.g. React's dev double-mount)
      // reuses the same element.
      target.width = layout.width;
      target.height = layout.height;
      const ctx = target.getContext("2d");
      if (!ctx) {
        setDrawState("error");
        return;
      }
      const { placeholders } = drawCollage(ctx, layout, images);
      const complete = placeholders.length === 0;
      setDrawState(complete ? "ready" : "partial");
      if (complete) {
        try {
          const png = await canvasToPng(target);
          if (!cancelled) pngRef.current = png;
        } catch {
          // Saving will say it couldn't; the collage itself is fine.
        }
      }
    }

    void draw(canvas);
    return () => {
      cancelled = true;
      pngRef.current = null;
      // Free the canvas's pixels now: mobile Safari caps total canvas memory.
      canvas.width = 0;
      canvas.height = 0;
    };
  }, [layout, near]);

  function handleSave() {
    const png = pngRef.current;
    const canvas = canvasRef.current;
    setSaveMessage(null);
    setSaving(true);
    // Normally the PNG is ready, so nothing is awaited before sharing starts
    // (it must start inside the tap). If it isn't ready yet, make it now.
    const save = png
      ? saveImageBlob(png, name)
      : canvas
        ? canvasToPng(canvas).then((blob) => saveImageBlob(blob, name))
        : Promise.reject(new Error("No collage"));
    save
      .then((result) => {
        if (result === "downloaded") setSaveMessage("Image saved to your downloads.");
      })
      .catch(() => setSaveMessage("Couldn't save this image. Try again, or take a screenshot instead."))
      .finally(() => setSaving(false));
  }

  async function handleReload() {
    if (!onReloadPictures) return;
    setReloading(true);
    try {
      await onReloadPictures();
    } finally {
      setReloading(false);
    }
  }

  const description = `Collage of ${items.map((i) => i.tags.description).join(", ")}`;
  const statusText =
    saveMessage ??
    (drawState === "partial"
      ? "Some pictures couldn't load."
      : drawState === "error"
        ? "Couldn't draw this collage."
        : "");

  return (
    <div className="space-y-2">
      <canvas
        ref={canvasRef}
        width={layout.width}
        height={layout.height}
        role="img"
        aria-label={description}
        data-testid="outfit-collage"
        data-state={drawState}
        className="bg-muted aspect-[4/5] w-full rounded-lg"
      />
      <div className="flex flex-wrap items-center justify-between gap-x-2">
        <p className="text-muted-foreground min-h-5 flex-1 text-xs" aria-live="polite">
          {statusText}
        </p>
        <div className="flex gap-1">
          {(drawState === "partial" || drawState === "error") && onReloadPictures && (
            <Button type="button" variant="ghost" onClick={() => void handleReload()} disabled={reloading}>
              <RefreshCwIcon aria-hidden />
              Reload pictures
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            onClick={handleSave}
            // Only a complete collage can be saved: a placeholder isn't worth keeping.
            disabled={drawState !== "ready" || saving}
            aria-label={`Save image of ${name}`}
          >
            <DownloadIcon aria-hidden />
            Save image
          </Button>
        </div>
      </div>
    </div>
  );
}
