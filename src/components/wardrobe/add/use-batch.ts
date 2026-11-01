"use client";

import { useCallback, useEffect, useState } from "react";
import type { BatchEntryState, BatchOutcome } from "@/lib/client/add-item";
import { noteAddedSeveral } from "../get-started/checklist";
import { keepBatchDraft } from "../review/batch-drafts";
import type { BatchRow } from "./batch-progress";

export interface BatchState {
  rows: BatchRow[];
  running: boolean;
  stoppedBy: unknown;
  /** How many photos or links were left out because a batch takes at most MAX_BATCH_SIZE. */
  extra: number;
}

/**
 * Runs one batch add at a time for a screen and keeps its rows in state.
 * Drafts (tagging failed) are kept for the review list as they arrive.
 * While a batch runs, leaving the page asks first, since the rest
 * wouldn't be added.
 */
export function useBatch(userId: string | null) {
  const [batch, setBatch] = useState<BatchState | null>(null);

  const setRow = useCallback(
    (index: number, state: BatchEntryState) => {
      if (state.kind === "draft") keepBatchDraft(userId, state.draft);
      if (state.kind === "saved") noteAddedSeveral(userId);
      setBatch((current) =>
        current ? { ...current, rows: current.rows.map((row, i) => (i === index ? { ...row, state } : row)) } : current,
      );
    },
    [userId],
  );

  const run = useCallback(
    async (labels: string[], extra: number, start: (onChange: (index: number, state: BatchEntryState) => void) => Promise<BatchOutcome>) => {
      setBatch({ rows: labels.map((label) => ({ label, state: { kind: "pending", stage: "waiting" } })), running: true, stoppedBy: null, extra });
      let stoppedBy: unknown = null;
      try {
        stoppedBy = (await start(setRow)).stoppedBy;
      } catch (error) {
        // runBatch catches per entry; this is only a safety net.
        stoppedBy = error;
      }
      setBatch((current) => (current ? { ...current, running: false, stoppedBy } : current));
    },
    [setRow],
  );

  const running = batch?.running ?? false;
  useEffect(() => {
    if (!running) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [running]);

  return { batch, run, setRow, clear: useCallback(() => setBatch(null), []) };
}
