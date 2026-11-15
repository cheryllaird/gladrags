"use client";

import { useCallback, useEffect, useState } from "react";
import type { Outfit } from "@/contracts";
import { outfitsApi } from "./api";
import { PickModelSheet } from "./pick-model-sheet";
import { EMPTY_RUNNER_STATE, PreviewRunner, RESULTS_POLICY, type PreviewPolicy, type PreviewRunnerState } from "./preview-runner";
import type { PreviewActivity } from "./preview-view";

/** Is a model preset picked? Anything but a clear answer lets the preview route decide. */
async function checkPreset(): Promise<"picked" | "missing" | "unknown"> {
  const result = await outfitsApi.getSettings();
  if (!result.ok) return "unknown";
  return result.data.modelPresetId ? "picked" : "missing";
}

/** The screen's one spoken progress line for pictures. Pure, so it's unit-tested. */
export function previewAnnouncement(state: PreviewRunnerState): string {
  if (state.needsPreset) return "";
  if (state.presetDismissed && state.queuedIds.length > 0) return "Outfit pictures are waiting until you pick a model.";
  if (!state.active) return "";
  if (state.active.refresh) return "Updating the picture…";
  const { done, total } = state.progress;
  return total > 1 ? `Making picture ${Math.min(done + 1, total)} of ${total}…` : "Making the picture…";
}

/**
 * Outfit pictures for one screen: a PreviewRunner that lives as long as the
 * screen, its state for rendering, the "Pick your model" sheet, and the
 * screen's one spoken progress line (`announcement`, for a screen with a
 * live line of its own, or `announcer` for one without).
 *
 * `onOutfit` gets each outfit as the preview route returns it; the screen
 * puts it in place of its copy. `policy` says which outfits are asked for
 * on their own (results: RESULTS_POLICY; saved list: SAVED_POLICY).
 */
export function usePreviews(onOutfit: (outfit: Outfit) => void, policy: PreviewPolicy = RESULTS_POLICY) {
  const [state, setState] = useState<PreviewRunnerState>(EMPTY_RUNNER_STATE);
  const [runner] = useState(
    () =>
      new PreviewRunner({
        requestPreview: (id, options) => outfitsApi.requestPreview(id, options),
        checkPreset,
        onChange: setState,
      }),
  );
  useEffect(() => runner.setOnOutfit(onOutfit), [runner, onOutfit]);

  // Stops polling (and drops answers) when the screen goes away.
  useEffect(() => {
    runner.start();
    return () => runner.stop();
  }, [runner]);

  const enqueue = useCallback((outfits: readonly Outfit[]) => runner.enqueue(outfits, policy), [runner, policy]);
  const ask = useCallback((outfit: Outfit) => runner.ask(outfit), [runner]);
  const refresh = useCallback((outfitId: string) => runner.refresh(outfitId), [runner]);
  const activity = useCallback((outfitId: string): PreviewActivity => runner.activityFor(state, outfitId), [runner, state]);

  const sheet = <PickModelSheet open={state.needsPreset} onSaved={() => runner.resume()} onDismissed={() => runner.dismissPreset()} />;
  // Screens with a live line of their own put `announcement` in it; others render `announcer`.
  const announcement = previewAnnouncement(state);
  const announcer = (
    <p role="status" aria-live="polite" className="sr-only" data-testid="preview-announcer">
      {announcement}
    </p>
  );

  return { enqueue, ask, refresh, activity, sheet, announcement, announcer };
}
