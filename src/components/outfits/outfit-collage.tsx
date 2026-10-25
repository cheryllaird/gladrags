"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { DownloadIcon } from "lucide-react";
import { displayImageUrl, type WardrobeItem } from "@/contracts";
import { Button } from "@/components/ui/button";
import { drawCollage, loadImage, saveCanvasAsImage } from "./collage-draw";
import { layoutCollage } from "./collage-layout";

type DrawState = "loading" | "ready" | "partial";

/**
 * An outfit's flat-lay collage, drawn on a canvas, with "Save image".
 * The canvas is drawn at full resolution and scaled down by CSS.
 */
export function OutfitCollage({ name, items }: { name: string; items: readonly WardrobeItem[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [drawState, setDrawState] = useState<DrawState>("loading");
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

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

  useEffect(() => {
    let cancelled = false;
    async function draw() {
      const results = await Promise.allSettled(layout.placed.map((p) => loadImage(p.imageUrl)));
      if (cancelled) return;
      const images = new Map<string, HTMLImageElement>();
      results.forEach((result, i) => {
        if (result.status === "fulfilled") images.set(layout.placed[i]!.id, result.value);
      });
      const ctx = canvasRef.current?.getContext("2d");
      if (!ctx) return;
      drawCollage(ctx, layout, images);
      setDrawState(images.size === layout.placed.length ? "ready" : "partial");
    }
    void draw();
    return () => {
      cancelled = true;
    };
  }, [layout]);

  async function handleSave() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    setSaving(true);
    setSaveMessage(null);
    try {
      const result = await saveCanvasAsImage(canvas, name);
      if (result === "downloaded") setSaveMessage("Image saved to your downloads.");
    } catch {
      setSaveMessage("Couldn't save this image. Try again, or take a screenshot instead.");
    } finally {
      setSaving(false);
    }
  }

  const description = `Collage of ${items.map((i) => i.tags.description).join(", ")}`;

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
        className="aspect-[4/5] w-full rounded-lg bg-muted"
      />
      <div className="flex items-center justify-between gap-2">
        <p className="text-muted-foreground min-h-5 text-xs" aria-live="polite">
          {saveMessage ?? (drawState === "partial" ? "Some pictures couldn't load." : "")}
        </p>
        <Button
          type="button"
          variant="ghost"
          onClick={handleSave}
          disabled={drawState === "loading" || saving}
          aria-label={`Save image of ${name}`}
        >
          <DownloadIcon aria-hidden />
          Save image
        </Button>
      </div>
    </div>
  );
}
