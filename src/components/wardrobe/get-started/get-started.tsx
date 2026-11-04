"use client";

import { CheckCircle2Icon, ChevronRightIcon, CircleIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import type { ChecklistStep } from "./checklist";

/**
 * The get-started checklist card. On an empty wardrobe it stands in for
 * the empty grid; on a nearly empty one it sits above the grid.
 */
export function GetStarted({
  steps,
  empty,
  onDismiss,
}: {
  steps: ChecklistStep[];
  /** No items yet: the card replaces the grid and says so. */
  empty: boolean;
  onDismiss: () => void;
}) {
  const done = steps.filter((step) => step.done).length;
  return (
    <section aria-labelledby="get-started-heading" className="space-y-4 rounded-lg border p-4">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          <h2 id="get-started-heading" className="font-semibold">
            {empty ? "Your wardrobe is empty" : "Get started"}
          </h2>
          <p className="text-muted-foreground text-sm">
            Outfits work from your first item: where something&apos;s missing, we suggest what to add.
          </p>
        </div>
        <Button variant="ghost" size="icon" className="-mt-1 -mr-2" aria-label="Hide the get-started checklist" onClick={onDismiss}>
          <XIcon aria-hidden="true" />
        </Button>
      </div>

      <div className="space-y-1.5">
        <p className="text-sm font-medium" aria-live="polite">
          {done} of {steps.length} done
        </p>
        <Progress value={Math.round((done / steps.length) * 100)} aria-label="Get-started progress" />
      </div>

      <ol className="-mx-1 space-y-1">
        {steps.map((step) => (
          <li key={step.id}>
            {step.done ? (
              <div className="flex items-start gap-3 rounded-md px-1 py-2">
                <CheckCircle2Icon className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
                <div className="min-w-0">
                  <p className="text-muted-foreground text-sm font-medium line-through">{step.title}</p>
                  <span className="sr-only">(done)</span>
                </div>
              </div>
            ) : (
              <Link
                href={step.href}
                className={cn(
                  "hover:bg-accent focus-visible:ring-ring/50 flex min-h-11 items-start gap-3 rounded-md px-1 py-2 outline-none focus-visible:ring-[3px]",
                )}
              >
                <CircleIcon className="text-muted-foreground mt-0.5 size-5 shrink-0" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{step.title}</p>
                  <p className="text-muted-foreground text-sm">{step.description}</p>
                </div>
                <ChevronRightIcon className="text-muted-foreground mt-0.5 size-5 shrink-0" aria-hidden="true" />
              </Link>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
