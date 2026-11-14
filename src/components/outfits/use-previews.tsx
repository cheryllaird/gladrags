"use client";

import { useCallback, useEffect, useState } from "react";
import type { Outfit } from "@/contracts";
import { outfitsApi } from "./api";
import { PickModelSheet } from "./pick-model-sheet";
import { EMPTY_RUNNER_STATE, PreviewRunner, type PreviewRunnerState } from "./preview-runner";
import type { PreviewActivity } from "./preview-view";

/** Is a model preset picked? Anything but a clear answer lets the preview route decide. */
async function checkPreset(): Promise<"picked" | "missing" | "unknown"> {
  const result = await outfitsApi.getSettings();
  if (!result.ok) return "unknown";
  return result.data.modelPresetId ? "picked" : "missing";
}

/**
 * Outfit pictures for one screen: a PreviewRunner that lives as long as the
 * screen, its state for rendering, and the "Pick your model" sheet.
 *
 * `onOutfit` gets each outfit as the preview route returns it; the screen
 * puts it in place of its copy.
 */
export function usePreviews(onOutfit: (outfit: Outfit) => void) {
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

  const enqueue = useCallback((outfits: readonly Outfit[]) => runner.enqueue(outfits), [runner]);
  const refresh = useCallback((outfitId: string) => runner.refresh(outfitId), [runner]);
  const activity = useCallback((outfitId: string): PreviewActivity => runner.activityFor(state, outfitId), [runner, state]);

  const sheet = <PickModelSheet open={state.needsPreset} onSaved={() => runner.resume()} />;

  return { enqueue, refresh, activity, sheet };
}
