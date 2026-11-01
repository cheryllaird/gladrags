"use client";

import { useEffect, useState } from "react";
import type { UserSettings } from "@/contracts";
import { PageBody, PageHeader } from "@/components/app-shell/page-header";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmailImports } from "@/components/settings/email-imports";
import { FavouriteShops } from "@/components/settings/favourite-shops";
import { ForwardingAddress } from "@/components/settings/forwarding-address";
import { ApiErrorNotice } from "@/components/wardrobe/api-error-notice";
import { getSettings } from "@/lib/client/api";

type State = { kind: "loading" } | { kind: "ready"; settings: UserSettings } | { kind: "error"; error: unknown };

/**
 * Settings (a page of its own rather than the account sheet: it has a
 * list to pick from, an address to copy and a history, which don't fit
 * a bottom sheet well). Opened from the account sheet and the get-started
 * checklist.
 */
export function SettingsScreen({ email }: { email: string | null }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    getSettings().then(
      (settings) => current && setState({ kind: "ready", settings }),
      (error: unknown) => current && setState({ kind: "error", error }),
    );
    return () => {
      current = false;
    };
  }, [attempt]);

  // Arriving at /settings#order-emails (the checklist): scroll there once the section exists.
  const ready = state.kind === "ready";
  useEffect(() => {
    if (ready && window.location.hash === "#order-emails") document.getElementById("order-emails")?.scrollIntoView();
  }, [ready]);

  const update = (settings: UserSettings) => setState({ kind: "ready", settings });

  return (
    <>
      <PageHeader title="Settings" backHref="/wardrobe" backLabel="Back to wardrobe" />
      <PageBody className="space-y-8">
        {state.kind === "loading" && (
          <div role="status" aria-label="Loading settings" className="space-y-3">
            <Skeleton className="h-6 w-1/2" />
            <Skeleton className="h-40 w-full rounded-lg" />
          </div>
        )}
        {state.kind === "error" && (
          <ApiErrorNotice error={state.error}>
            <Button
              variant="outline"
              className="mt-2"
              onClick={() => {
                setState({ kind: "loading" });
                setAttempt((n) => n + 1);
              }}
            >
              Try again
            </Button>
          </ApiErrorNotice>
        )}
        {state.kind === "ready" && (
          <>
            <ForwardingAddress address={state.settings.forwardingAddress} email={email} onReset={update} />
            <EmailImports />
            <FavouriteShops saved={state.settings.favouriteShopIds} onSaved={update} />
          </>
        )}
      </PageBody>
    </>
  );
}
