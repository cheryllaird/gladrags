"use client";

import { AlertCircleIcon, CheckCircle2Icon, Loader2Icon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { EmailImport } from "@/contracts";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiErrorNotice } from "@/components/wardrobe/api-error-notice";
import { listEmailImports } from "@/lib/client/api";
import { emailImportStatus, formatImportDate } from "./email-import-copy";

type State = { kind: "loading" } | { kind: "ready"; imports: EmailImport[] } | { kind: "error"; error: unknown };

/** The 20 most recent forwarded emails, what came of each, and why any were refused. */
export function EmailImports() {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    let current = true;
    listEmailImports().then(
      (imports) => current && setState({ kind: "ready", imports }),
      (error: unknown) => current && setState({ kind: "error", error }),
    );
    return () => {
      current = false;
    };
  }, [attempt]);

  return (
    <section aria-labelledby="imports-heading" className="space-y-3">
      <div className="flex items-center gap-2">
        <h2 id="imports-heading" className="flex-1 font-semibold">
          Recent order emails
        </h2>
        <Button variant="ghost" size="sm" className="min-h-11" onClick={reload} aria-label="Refresh the list of order emails">
          <RefreshCwIcon aria-hidden="true" />
          Refresh
        </Button>
      </div>

      {state.kind === "loading" && <Skeleton className="h-16 w-full rounded-lg" role="status" aria-label="Loading order emails" />}
      {state.kind === "error" && <ApiErrorNotice error={state.error} />}
      {state.kind === "ready" && state.imports.length === 0 && (
        <p className="text-muted-foreground text-sm">No order emails yet. Ones you forward show up here.</p>
      )}
      {state.kind === "ready" && state.imports.length > 0 && (
        <ul className="divide-y rounded-lg border">
          {state.imports.map((entry) => {
            const { summary, reason } = emailImportStatus(entry);
            const Icon = entry.status === "processing" ? Loader2Icon : entry.status === "failed" ? AlertCircleIcon : CheckCircle2Icon;
            return (
              <li key={entry.id} className="flex items-start gap-3 px-3 py-2.5" data-status={entry.status}>
                <Icon
                  className={`mt-0.5 size-5 shrink-0 ${entry.status === "processing" ? "animate-spin" : ""} ${entry.status === "failed" ? "text-destructive" : ""}`}
                  aria-hidden="true"
                />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">
                    {entry.shopName ?? "An email"}
                    <span className="text-muted-foreground font-normal"> · {formatImportDate(entry.receivedAt)}</span>
                  </p>
                  <p className="text-sm">{summary}</p>
                  {reason && <p className="text-muted-foreground text-sm">{reason}</p>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
