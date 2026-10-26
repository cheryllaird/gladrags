import { CheckIcon, Loader2Icon } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

export interface ProgressStep {
  id: string;
  label: string;
}

/**
 * What's happening while an item is processed: a bar plus a checklist of
 * steps. Announced politely to screen readers as the step changes.
 */
export function ProgressSteps({
  steps,
  current,
  preview,
  heading = "Adding your item",
}: {
  steps: ProgressStep[];
  current: string;
  /** Local object URL of the photo being processed, if there is one. */
  preview?: string | null;
  heading?: string;
}) {
  const index = Math.max(0, steps.findIndex((step) => step.id === current));
  const currentLabel = steps[index]?.label ?? "";
  const value = Math.round(((index + 0.5) / steps.length) * 100);

  return (
    <section aria-label={heading} className="space-y-5">
      {preview && (
        // eslint-disable-next-line @next/next/no-img-element -- local blob: URL
        <img src={preview} alt="" className="bg-muted mx-auto aspect-square w-48 rounded-lg object-cover" />
      )}
      <div className="space-y-2">
        <p className="text-center font-medium" role="status" aria-live="polite">
          {currentLabel}…
        </p>
        <Progress value={value} aria-label={heading} />
      </div>
      <ol className="space-y-2">
        {steps.map((step, i) => {
          const done = i < index;
          const active = i === index;
          return (
            <li key={step.id} className={cn("flex items-center gap-3 text-sm", !done && !active && "text-muted-foreground")}>
              <span className="flex size-6 items-center justify-center" aria-hidden="true">
                {done ? (
                  <CheckIcon className="size-4" />
                ) : active ? (
                  <Loader2Icon className="size-4 animate-spin" />
                ) : (
                  <span className="bg-border size-2 rounded-full" />
                )}
              </span>
              <span>
                {step.label}
                <span className="sr-only">{done ? " (done)" : active ? " (in progress)" : ""}</span>
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
