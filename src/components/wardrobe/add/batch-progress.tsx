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
import { useId, useRef, useState } from "react";
import type { WardrobeItem } from "@/contracts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { summariseBatch, type BatchEntryState } from "@/lib/client/add-item";
import { cn } from "@/lib/utils";
import { batchEntryLabel, batchSummaryCopy, plural, type BatchKind } from "./batch-copy";
import { DraftReview } from "./draft-review";

export interface BatchRow {
  /** "Photo 3", or the link. */
  label: string;
  state: BatchEntryState;
  /** A draft that couldn't be kept for the review list (storage blocked): fill it in from here. */
  unkeptDraft?: boolean;
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
  onRowChange,
  userId = null,
  actions,
}: {
  kind: BatchKind;
  rows: BatchRow[];
  running: boolean;
  stoppedBy: unknown;
  /** Links only: a screenshot chosen for the row at `index`, which needed the fallback. */
  onScreenshot?: (index: number, file: File) => void;
  /** A row's new state after the user acts on it here (a draft filled in now). */
  onRowChange?: (index: number, state: BatchEntryState) => void;
  /** The signed-in user, for a draft filled in here (see DraftReview). */
  userId?: string | null;
  /** Buttons under the summary (review, add more). */
  actions?: React.ReactNode;
}) {
  // A draft that couldn't be kept, being filled in now (its row index).
  const [filling, setFilling] = useState<number | null>(null);
  const states = rows.map((row) => row.state);
  const summary = summariseBatch(states);
  const unkeptDrafts = rows.filter((row) => row.state.kind === "draft" && row.unkeptDraft).length;
  const copy = batchSummaryCopy(kind, states, stoppedBy, { unkeptDrafts });
  // One screenshot at a time: while one uploads, the other rows wait.
  const screenshotBusy = !running && rows.some((row) => row.state.kind === "pending");

  const fillingRow = filling === null ? null : rows[filling];
  if (fillingRow?.state.kind === "draft" && filling !== null) {
    const index = filling;
    return (
      <section aria-label="Fill in the tags" className="space-y-4">
        <Button variant="ghost" className="-ml-2" onClick={() => setFilling(null)}>
          Back to the list
        </Button>
        <DraftReview
          userId={userId}
          draft={fillingRow.state.draft}
          onSaved={(item: WardrobeItem) => {
            onRowChange?.(index, { kind: "saved", item });
            setFilling(null);
          }}
          onDiscard={() => {
            onRowChange?.(index, { kind: "not_added" });
            setFilling(null);
          }}
        />
      </section>
    );
  }
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
            screenshotBusy={screenshotBusy}
            onScreenshot={(file) => onScreenshot?.(index, file)}
            onFillIn={onRowChange && !running ? () => setFilling(index) : undefined}
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
  screenshotBusy,
  onScreenshot,
  onFillIn,
}: {
  row: BatchRow;
  canScreenshot: boolean;
  screenshotBusy: boolean;
  onScreenshot: (file: File) => void;
  onFillIn?: () => void;
}) {
  const { state } = row;
  const muted = state.kind === "not_added" || (state.kind === "pending" && state.stage === "waiting");
  const fillNow = state.kind === "draft" && row.unkeptDraft;
  return (
    <li className="flex items-start gap-3 px-3 py-2.5" data-state={state.kind}>
      <span className="pt-0.5">
        <StateIcon state={state} />
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        <p className="truncate text-sm font-medium">{row.label}</p>
        <p className={cn("text-sm", muted ? "text-muted-foreground" : state.kind === "failed" ? "text-destructive" : undefined)}>
          {fillNow ? "Couldn't be tagged, and this browser won't let us keep it for later. Fill this in now." : batchEntryLabel(state)}
        </p>
        {state.kind === "needs_screenshot" && canScreenshot && (
          <ScreenshotButton label={row.label} disabled={screenshotBusy} onFile={onScreenshot} />
        )}
        {fillNow && onFillIn && (
          <Button type="button" variant="outline" size="lg" className="w-full" aria-label={`Fill in tags: ${row.label}`} onClick={onFillIn}>
            <PencilLineIcon aria-hidden="true" />
            Fill in tags
          </Button>
        )}
      </div>
    </li>
  );
}

function ScreenshotButton({ label, disabled, onFile }: { label: string; disabled: boolean; onFile: (file: File) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const id = useId();
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="lg"
        className="w-full"
        disabled={disabled}
        aria-label={`Add a screenshot: ${label}`}
        onClick={() => ref.current?.click()}
      >
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
