"use client";

import { useState } from "react";
import { DEFAULT_MODEL_PRESET_ID, MODEL_PRESET_IMAGES_ARE_PLACEHOLDERS, type ModelPresetId } from "@/contracts";
import { ModelPresetGrid } from "@/components/model-presets";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { outfitsApi, type ApiFailure } from "./api";
import { ApiErrorNotice } from "./result-notices";

/**
 * "Pick your model": shown the first time outfit pictures are made and no
 * model figure is picked yet (docs/CONTRACTS.md section 12, "Picking the
 * model"). The default is preselected. Confirming saves the choice;
 * closing the sheet saves the default, so the user is asked exactly once.
 * Either way `onSaved` runs and the pictures start.
 *
 * If "Use this model" can't be saved, the sheet stays open with the error
 * to try again. If closing can't save the default, the sheet closes anyway
 * (`onDismissed`): the pictures wait, and the next time pictures are
 * wanted the user is asked again.
 */
export function PickModelSheet({ open, onSaved, onDismissed }: { open: boolean; onSaved: () => void; onDismissed: () => void }) {
  const [selected, setSelected] = useState<ModelPresetId>(DEFAULT_MODEL_PRESET_ID);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ApiFailure | null>(null);

  async function save(id: ModelPresetId, closing: boolean) {
    if (saving) return;
    setSaving(true);
    setError(null);
    const result = await outfitsApi.saveModelPreset(id);
    setSaving(false);
    if (result.ok) onSaved();
    else if (closing) onDismissed();
    // The sheet stays open with the error, so the choice can be saved again.
    else setError(result.error);
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        // Closing keeps the default (contract): save it, then the pictures start.
        if (!next) void save(DEFAULT_MODEL_PRESET_ID, true);
      }}
    >
      <SheetContent
        side="bottom"
        data-testid="pick-model-sheet"
        className="mx-auto max-h-[90dvh] w-full max-w-md gap-0 rounded-t-xl [&>button:last-child]:flex [&>button:last-child]:size-11 [&>button:last-child]:items-center [&>button:last-child]:justify-center [&>button:last-child]:top-2 [&>button:last-child]:right-2"
      >
        <SheetHeader className="pr-14">
          <SheetTitle className="text-lg">Pick your model</SheetTitle>
          <SheetDescription>
            Your outfit pictures show this figure wearing them. You can change it any time in settings.
            {MODEL_PRESET_IMAGES_ARE_PLACEHOLDERS ? " These are placeholder figures for now." : ""}
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-2">
          <ModelPresetGrid value={selected} onChange={setSelected} disabled={saving} />
        </div>
        <SheetFooter className="border-t pt-3">
          {error && <ApiErrorNotice error={error} context="outfits" />}
          <Button type="button" className="w-full" disabled={saving} onClick={() => void save(selected, false)}>
            {saving ? "Saving…" : "Use this model"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
