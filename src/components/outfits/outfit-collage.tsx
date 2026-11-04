"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { DownloadIcon, RefreshCwIcon } from "lucide-react";
import { collageImageUrl, type OutfitGap, type WardrobeItem } from "@/contracts";
import { Button } from "@/components/ui/button";
import { canvasToPng, drawCollage, hasVisibleContent, loadImage, saveImageBlob } from "./collage-draw";
import { collageCutouts, collageCutoutsEnabled } from "./collage-cutouts";
import { layoutCollage, type CollageItem } from "./collage-layout";
import { collageDescription, gapToCollageItem } from "./gap-copy";
import { needsCutout } from "./cutout-queue";

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
  /** Slots the wardrobe doesn't fill: drawn as dashed placeholders. */
  gaps?: readonly OutfitGap[];
  /** Only load and draw once the collage is near the screen (long lists). */
  lazy?: boolean;
  /**
   * Fetch the outfit again for fresh image URLs. Offered as "Reload
   * pictures" when some pictures didn't load (e.g. their signed URLs expired).
   */
  onReloadPictures?: () => Promise<void>;
}

/**
 * The collage's content as one string, so a fresh copy of the same outfit
 * (e.g. after a shop search, which returns the whole outfit) doesn't redraw.
 */
function contentKey(items: readonly CollageItem[]): string {
  return JSON.stringify(items);
}

/**
 * An outfit's flat-lay collage, drawn on a canvas, with "Save image".
 * The canvas is drawn at full resolution and scaled down by CSS.
 *
 * It's drawn straight away with what each item has (its cut-out, or else
 * its original). Items without a cut-out are then cut out in the browser
 * one at a time (collageCutouts), and each cut-out is swapped in as it
 * arrives. The collage never waits for that.
 */
export function OutfitCollage({ name, items, gaps = [], lazy = false, onReloadPictures }: OutfitCollageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  /** The finished collage as a PNG, made ahead so "Save image" can share straight from the tap. */
  const pngRef = useRef<Blob | null>(null);
  const [near, setNear] = useState(!lazy);
  const [drawState, setDrawState] = useState<DrawState>(lazy ? "idle" : "loading");
  /** How many cut-outs made here have been swapped in (for tests and debugging). */
  const [cutoutsShown, setCutoutsShown] = useState(0);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [reloading, setReloading] = useState(false);

  const collageItems = useMemo(
    (): CollageItem[] => [
      ...items.map((item) => ({
        id: item.id,
        category: item.tags.category,
        imageUrl: collageImageUrl(item),
        label: item.tags.description,
      })),
      ...gaps.map(gapToCollageItem),
    ],
    [items, gaps],
  );
  const key = contentKey(collageItems);
  // Recomputed only when the content changes, not on every new array.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const layout = useMemo(() => layoutCollage(collageItems), [key]);
  // Which items to cut out: the latest copies, looked up by ID.
  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

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
    // Calls off this collage's queued cut-outs if it goes away first.
    const unmounted = new AbortController();
    let paintCount = 0;
    const images = new Map<string, HTMLImageElement>();

    /** Draw with whatever images are loaded now, then get the PNG ready for saving. */
    async function paint(target: HTMLCanvasElement) {
      const paintNumber = ++paintCount;
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
      pngRef.current = null;
      if (complete) {
        try {
          const png = await canvasToPng(target);
          // A newer paint (a cut-out arrived meanwhile) makes its own PNG.
          if (!cancelled && paintNumber === paintCount) pngRef.current = png;
        } catch {
          // Saving will say it couldn't; the collage itself is fine.
        }
      }
    }

    async function swapInCutout(target: HTMLCanvasElement, url: string, itemId: string) {
      try {
        const img = await loadImage(url);
        // A cut-out that kept nothing would only make things worse.
        if (cancelled || !hasVisibleContent(img)) return;
        images.set(itemId, img);
        setCutoutsShown((n) => n + 1);
        await paint(target);
      } catch {
        // Keep the original.
      }
    }

    async function draw(target: HTMLCanvasElement) {
      setDrawState("loading");
      setCutoutsShown(0);
      pngRef.current = null;
      const placedItems = layout.placed.filter((p) => !p.gap && p.imageUrl);
      // A cut-out made earlier this session is drawn from the start.
      const cutoutIds = new Set<string>();
      const urls = placedItems.map((p) => {
        const made = collageCutouts.peek(p.id)?.url;
        if (made) cutoutIds.add(p.id);
        return made ?? p.imageUrl!;
      });
      const results = await Promise.allSettled(urls.map((url) => loadImage(url)));
      if (cancelled) return;
      results.forEach((result, i) => {
        if (result.status === "fulfilled") images.set(placedItems[i]!.id, result.value);
      });
      await paint(target);
      if (cancelled || !collageCutoutsEnabled()) return;

      // Then cut out the items that still have no cut-out, one at a time
      // (the queue runs them in order), swapping each in as it's ready.
      const byId = new Map(itemsRef.current.map((item) => [item.id, item]));
      for (const placed of placedItems) {
        const item = byId.get(placed.id);
        if (!item || cutoutIds.has(item.id) || !needsCutout(item)) continue;
        // Swapped in as soon as it's made, not when the upload finishes.
        void collageCutouts.request(item, unmounted.signal, (url) => {
          if (!cancelled) void swapInCutout(target, url, item.id);
        });
      }
    }

    void draw(canvas);
    return () => {
      cancelled = true;
      unmounted.abort();
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

  const description = collageDescription(items, gaps);
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
        data-gaps={gaps.length}
        data-cutouts={cutoutsShown}
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
            // (A gap's dashed placeholder is intended, so it doesn't stop saving.)
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
