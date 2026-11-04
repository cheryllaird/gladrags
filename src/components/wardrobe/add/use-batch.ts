"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { BatchEntryState, BatchOutcome } from "@/lib/client/add-item";
import { noteAddedSeveral } from "../get-started/checklist";
import { keepBatchDraft } from "../review/batch-drafts";
import type { BatchKind } from "./batch-copy";
import type { BatchRow } from "./batch-progress";

export interface BatchState {
  rows: BatchRow[];
  running: boolean;
  stoppedBy: unknown;
  /** How many photos or links were left out because a batch takes at most MAX_BATCH_SIZE. */
  extra: number;
}

/** What the in-app navigation guard asks while a batch runs. */
export const LEAVE_MESSAGES: Record<BatchKind, string> = {
  photo: "Photos are still uploading. Leave anyway?",
  link: "Links are still being added. Leave anyway?",
};

/** The browser's confirm box; tests replace it. */
export const leaveConfirm = {
  ask(message: string): boolean {
    return window.confirm(message);
  },
};

/**
 * Runs one batch add at a time for a screen and keeps its rows in state.
 *
 * - Drafts (tagging failed) are kept for the review list as they arrive;
 *   a draft that can't be kept (storage blocked) is flagged on its row so
 *   the screen offers the fill-in straight away.
 * - While a batch runs, leaving asks first: a reload or closing the tab
 *   gets the browser's own prompt, and a tap on an in-app link (the back
 *   link, the bottom nav) gets a confirm. If the user leaves anyway, the
 *   batch is aborted: the photo or link in flight finishes, the rest
 *   aren't added.
 * - The guard is dropped the moment a batch stops, before the API client's
 *   deferred redirect to sign-in (on `unauthorized`) can run, so an expired
 *   session never shows "Leave site?".
 */
export function useBatch(userId: string | null, kind: BatchKind) {
  const [batch, setBatch] = useState<BatchState | null>(null);
  // Read by the leave guards synchronously, so it's a ref as well as state.
  const runningRef = useRef(false);
  const controllerRef = useRef<AbortController | null>(null);

  const setRow = useCallback(
    (index: number, state: BatchEntryState) => {
      const unkept = state.kind === "draft" && !keepBatchDraft(userId, state.draft);
      if (state.kind === "saved") noteAddedSeveral(userId);
      setBatch((current) =>
        current
          ? { ...current, rows: current.rows.map((row, i) => (i === index ? { ...row, state, unkeptDraft: unkept } : row)) }
          : current,
      );
    },
    [userId],
  );

  const run = useCallback(
    async (
      labels: string[],
      extra: number,
      start: (onChange: (index: number, state: BatchEntryState) => void, signal: AbortSignal) => Promise<BatchOutcome>,
    ) => {
      // Never two batches at once.
      if (runningRef.current) return;
      runningRef.current = true;
      const controller = new AbortController();
      controllerRef.current = controller;
      setBatch({ rows: labels.map((label) => ({ label, state: { kind: "pending", stage: "waiting" } })), running: true, stoppedBy: null, extra });
      let stoppedBy: unknown = null;
      try {
        stoppedBy = (await start(setRow, controller.signal)).stoppedBy;
      } catch (error) {
        // runBatch catches per entry; this is only a safety net.
        stoppedBy = error;
      }
      // Synchronously, in the same microtask chain as the failed request:
      // the sign-in redirect is a later macrotask, so the guard is already off.
      runningRef.current = false;
      if (controllerRef.current === controller) controllerRef.current = null;
      setBatch((current) => (current ? { ...current, running: false, stoppedBy } : current));
    },
    [setRow],
  );

  // Leaving the screen (in-app navigation the user confirmed) stops the batch.
  useEffect(() => () => controllerRef.current?.abort(), []);

  const running = batch?.running ?? false;
  useEffect(() => {
    if (!running) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (runningRef.current) event.preventDefault();
    };
    // Capture on the document runs before Next's own Link handler (on the React root).
    const onClick = (event: MouseEvent) => {
      if (!runningRef.current || event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = (event.target as Element | null)?.closest?.("a[href]");
      if (!(link instanceof HTMLAnchorElement) || (link.target && link.target !== "_self")) return;
      if (link.origin !== window.location.origin) return;
      if (!leaveConfirm.ask(LEAVE_MESSAGES[kind])) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, [running, kind]);

  return { batch, run, setRow, clear: useCallback(() => setBatch(null), []) };
}
