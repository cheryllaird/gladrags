"use client";

import { CheckIcon } from "lucide-react";
import { useState } from "react";
import { SHOPS, type ShopId, type UserSettings } from "@/contracts";
import { Button } from "@/components/ui/button";
import { ApiErrorNotice } from "@/components/wardrobe/api-error-notice";
import { updateFavouriteShops } from "@/lib/client/api";
import { cn } from "@/lib/utils";

/**
 * Pick the shops "Find in my shops" searches, from the contract's fixed
 * list (at least one). Saved with PUT /api/settings.
 */
export function FavouriteShops({ saved, onSaved }: { saved: ShopId[]; onSaved: (settings: UserSettings) => void }) {
  const [chosen, setChosen] = useState<ShopId[]>(saved);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const changed = chosen.length !== saved.length || chosen.some((id) => !saved.includes(id));

  function toggle(id: ShopId) {
    setNotice(null);
    // Keep the list's own order, so what's saved doesn't depend on tap order.
    setChosen((current) => SHOPS.map((s) => s.id).filter((s) => (s === id ? !current.includes(id) : current.includes(s))));
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const settings = await updateFavouriteShops(chosen);
      onSaved(settings);
      setChosen(settings.favouriteShopIds);
      setNotice("Shops saved.");
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="shops-heading" className="space-y-3">
      <div className="space-y-1">
        <h2 id="shops-heading" className="font-semibold">
          Favourite shops
        </h2>
        <p className="text-muted-foreground text-sm">
          When an outfit is missing something, &ldquo;Find in my shops&rdquo; looks for it in these.
        </p>
      </div>
      <fieldset>
        <legend className="sr-only">Favourite shops</legend>
        <div className="grid grid-cols-2 gap-2">
          {SHOPS.map((shop) => {
            const on = chosen.includes(shop.id);
            return (
              <label
                key={shop.id}
                className={cn(
                  "has-focus-visible:ring-ring/50 flex min-h-11 cursor-pointer items-center gap-2 rounded-md border px-3 text-sm has-focus-visible:ring-[3px]",
                  on && "border-primary bg-primary/5 font-medium",
                )}
              >
                <input type="checkbox" className="sr-only" checked={on} onChange={() => toggle(shop.id)} />
                <span
                  className={cn("flex size-4 shrink-0 items-center justify-center rounded-sm border", on && "bg-primary border-primary text-primary-foreground")}
                  aria-hidden="true"
                >
                  {on && <CheckIcon className="size-3" />}
                </span>
                {shop.name}
              </label>
            );
          })}
        </div>
      </fieldset>
      {chosen.length === 0 && (
        <p className="text-destructive text-sm" role="alert">
          Pick at least one shop.
        </p>
      )}
      {error !== null && <ApiErrorNotice error={error} />}
      {notice && !changed && (
        <p role="status" className="bg-muted rounded-md px-3 py-2 text-sm">
          {notice}
        </p>
      )}
      {changed && (
        <Button size="lg" className="w-full" disabled={busy || chosen.length === 0} onClick={() => void save()}>
          {busy ? "Saving…" : "Save shops"}
        </Button>
      )}
    </section>
  );
}
