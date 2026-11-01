"use client";

import {
  AlertCircleIcon,
  CheckCircle2Icon,
  CircleDashedIcon,
  ImageOffIcon,
  ImagePlusIcon,
  Loader2Icon,
  PencilLineIcon,
  TimerIcon,
} from "lucide-react";
import { useId, useRef } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { summariseBatch, type BatchEntryState } from "@/lib/client/add-item";
import { cn } from "@/lib/utils";
import { batchEntryLabel, batchSummaryCopy, plural, type BatchKind } from "./batch-copy";

export interface BatchRow {
  /** "Photo 3", or the link. */
  label: string;
  state: BatchEntryState;
}

/**
 * A batch add (several photos or links) in progress and, once finished,
 * its summary: per-item progress, what was added, what needs tags or a
 * screenshot, and where it stopped if it hit the daily cap.
 */
export function BatchProgress({
  kind,
  rows,
  running,
  stoppedBy,
  onScreenshot,
  actions,
}: {
  kind: BatchKind;
  rows: BatchRow[];
  running: boolean;
  stoppedBy: unknown;
  /** Links only: a screenshot chosen for the row at `index`, which needed the fallback. */
  onScreenshot?: (index: number, file: File) => void;
  /** Buttons under the summary (review, add more). */
  actions?: React.ReactNode;
}) {
  const states = rows.map((row) => row.state);
  const summary = summariseBatch(states);
  const copy = batchSummaryCopy(kind, states, stoppedBy);
  const heading = running ? `Adding ${plural(summary.total, kind)}` : copy.title;
  // The summary stays live: a screenshot added afterwards updates its counts.
  const needScreenshot = rows.some((row) => row.state.kind === "needs_screenshot");

  return (
    <section aria-label={running ? heading : "Summary"} className="space-y-5">
      {running ? (
        <div className="space-y-2">
          <p className="text-center font-medium" role="status" aria-live="polite">
            {summary.finished} of {plural(summary.total, kind)} done
          </p>
          <Progress value={Math.round((summary.finished / Math.max(1, summary.total)) * 100)} aria-label={heading} />
          <p className="text-muted-foreground text-center text-xs">
            Keep this screen open until they&apos;re all done. Each one is saved as soon as it&apos;s tagged.
          </p>
        </div>
      ) : (
        <Alert variant={copy.stopped === "error" ? "destructive" : "default"} data-error-kind={copy.stopped ?? undefined}>
          {copy.stopped ? <TimerIcon /> : <CheckCircle2Icon />}
          <AlertTitle role="status">{copy.title}</AlertTitle>
          <AlertDescription>
            {copy.lines.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </AlertDescription>
        </Alert>
      )}

      {!running && actions && <div className="grid gap-2">{actions}</div>}

      {!running && needScreenshot && (
        <p className="text-muted-foreground text-sm">
          For each link that needs one, screenshot the product on the shop&apos;s page, then add it here. We&apos;ll keep the link with the item.
        </p>
      )}

      <ol className="divide-y rounded-lg border" aria-label={kind === "photo" ? "Photos" : "Links"}>
        {rows.map((row, index) => (
          <BatchRowView
            key={index}
            row={row}
            canScreenshot={!running && onScreenshot !== undefined}
            onScreenshot={(file) => onScreenshot?.(index, file)}
          />
        ))}
      </ol>
    </section>
  );
}

function StateIcon({ state }: { state: BatchEntryState }) {
  const className = "size-5 shrink-0";
  switch (state.kind) {
    case "pending":
      return state.stage === "waiting" ? (
        <CircleDashedIcon className={cn(className, "text-muted-foreground")} aria-hidden="true" />
      ) : (
        <Loader2Icon className={cn(className, "animate-spin")} aria-hidden="true" />
      );
    case "saved":
      return <CheckCircle2Icon className={className} aria-hidden="true" />;
    case "draft":
      return <PencilLineIcon className={className} aria-hidden="true" />;
    case "needs_screenshot":
      return <ImageOffIcon className={className} aria-hidden="true" />;
    case "failed":
      return <AlertCircleIcon className={cn(className, "text-destructive")} aria-hidden="true" />;
    case "not_added":
      return <CircleDashedIcon className={cn(className, "text-muted-foreground")} aria-hidden="true" />;
  }
}

function BatchRowView({
  row,
  canScreenshot,
  onScreenshot,
}: {
  row: BatchRow;
  canScreenshot: boolean;
  onScreenshot: (file: File) => void;
}) {
  const { state } = row;
  const muted = state.kind === "not_added" || (state.kind === "pending" && state.stage === "waiting");
  return (
    <li className="flex items-start gap-3 px-3 py-2.5" data-state={state.kind}>
      <span className="pt-0.5">
        <StateIcon state={state} />
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        <p className="truncate text-sm font-medium">{row.label}</p>
        <p className={cn("text-sm", muted ? "text-muted-foreground" : state.kind === "failed" ? "text-destructive" : undefined)}>
          {batchEntryLabel(state)}
        </p>
        {state.kind === "needs_screenshot" && canScreenshot && <ScreenshotButton onFile={onScreenshot} />}
      </div>
    </li>
  );
}

function ScreenshotButton({ onFile }: { onFile: (file: File) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const id = useId();
  return (
    <>
      <Button type="button" variant="outline" size="lg" className="w-full" onClick={() => ref.current?.click()}>
        <ImagePlusIcon aria-hidden="true" />
        Add a screenshot
      </Button>
      <input
        ref={ref}
        id={id}
        type="file"
        accept="image/*"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        data-testid="screenshot-input"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) onFile(file);
        }}
      />
    </>
  );
}
