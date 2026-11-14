"use client";

import { useRef, useState } from "react";
import { DEFAULT_MODEL_PRESET_ID, type ModelPresetId, type UserSettings } from "@/contracts";
import { ModelPresetGrid, findPreset } from "@/components/model-presets";
import { Button } from "@/components/ui/button";
import { ApiErrorNotice } from "@/components/wardrobe/api-error-notice";
import { updateModelPreset } from "@/lib/client/api";

/**
 * "Your model": the preset figure new outfit previews are made on (spec:
 * "Generated outfit preview"). Shows the saved one, or "Not picked yet",
 * and opens the shared grid to change it. Saved with PUT /api/settings
 * { modelPresetId }; on failure the saved one stays and the picker stays
 * open with the user's choice, to try again.
 */
export function ModelPresetSetting({ saved, onSaved }: { saved: string | null; onSaved: (settings: UserSettings) => void }) {
  const current = findPreset(saved);
  const [picking, setPicking] = useState(false);
  // What's tapped in the open picker. Starts on the saved one, or the default when none is picked.
  const [draft, setDraft] = useState<ModelPresetId>(DEFAULT_MODEL_PRESET_ID);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const changeButton = useRef<HTMLButtonElement>(null);

  function open() {
    setDraft((current?.id as ModelPresetId | undefined) ?? DEFAULT_MODEL_PRESET_ID);
    setError(null);
    setNotice(null);
    setPicking(true);
  }

  function close() {
    setPicking(false);
    setError(null);
    // Back to where the user was: the button the picker opened from.
    requestAnimationFrame(() => changeButton.current?.focus());
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const settings = await updateModelPreset(draft);
      onSaved(settings);
      setNotice("Model saved.");
      close();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const draftPreset = findPreset(draft);
  const unchanged = current !== null && draft === current.id;

  return (
    <section aria-labelledby="model-heading" className="space-y-3">
      <div className="space-y-1">
        <h2 id="model-heading" className="font-semibold">
          Your model
        </h2>
        <p className="text-muted-foreground text-sm">Previews of new outfits use this model. Existing previews stay as they are.</p>
      </div>

      <div className="flex items-center gap-3 rounded-lg border p-2" data-testid="current-model">
        {current ? (
          // eslint-disable-next-line @next/next/no-img-element -- a small static preset picture from public/presets
          <img src={current.imagePath} alt="" className="bg-muted aspect-[2/3] w-12 shrink-0 rounded-md object-cover" />
        ) : (
          <span className="bg-muted aspect-[2/3] w-12 shrink-0 rounded-md" aria-hidden="true" />
        )}
        <p className="min-w-0 flex-1 text-sm">{current ? current.label : <span className="text-muted-foreground">Not picked yet</span>}</p>
        {!picking && (
          <Button ref={changeButton} variant="outline" onClick={open} aria-label={current ? "Change model" : "Choose a model"}>
            {current ? "Change" : "Choose"}
          </Button>
        )}
      </div>

      {notice && !picking && (
        <p role="status" className="bg-muted rounded-md px-3 py-2 text-sm">
          {notice}
        </p>
      )}

      {picking && (
        <div className="space-y-3" data-testid="model-picker">
          <ModelPresetGrid value={draft} onChange={setDraft} disabled={busy} label="Your model" />
          {draftPreset && (
            <p className="text-sm" aria-live="polite">
              Selected: {draftPreset.label}
            </p>
          )}
          {error !== null && <ApiErrorNotice error={error} />}
          <div className="grid grid-cols-2 gap-2">
            <Button variant="outline" size="lg" disabled={busy} onClick={close}>
              Cancel
            </Button>
            <Button size="lg" disabled={busy || unchanged} onClick={() => void save()}>
              {busy ? "Saving…" : "Save model"}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
