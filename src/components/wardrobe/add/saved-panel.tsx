"use client";

import { CheckCircle2Icon } from "lucide-react";
import Link from "next/link";
import type { WardrobeItem } from "@/contracts";
import { Button } from "@/components/ui/button";
import { ItemImage } from "../item-image";

/**
 * Shown straight after saving. "Add another" comes first and opens the
 * camera directly, because adding 20 items quickly is a success criterion.
 */
export function SavedPanel({ item, children }: { item: WardrobeItem; children: React.ReactNode }) {
  return (
    <div className="space-y-6">
      <div className="space-y-3 text-center">
        <ItemImage item={item} alt="" className="mx-auto w-32" />
        <p role="status" className="flex items-center justify-center gap-2 text-lg font-semibold">
          <CheckCircle2Icon className="size-5" aria-hidden="true" />
          Saved to your wardrobe
        </p>
        <p className="text-muted-foreground text-sm">{item.tags.description}</p>
      </div>
      <div className="space-y-2">
        <h2 className="text-sm font-medium">Add another</h2>
        {children}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Button asChild variant="ghost">
          <Link href={`/wardrobe/${item.id}`}>View item</Link>
        </Button>
        <Button asChild variant="ghost">
          <Link href="/wardrobe">Go to wardrobe</Link>
        </Button>
      </div>
    </div>
  );
}
