import { AlertCircleIcon, LogInIcon, PauseCircleIcon, TimerIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ApiClientError } from "@/lib/client/api";

const UK_TIME = "Europe/London";

/** "midnight" style reset times, in UK time to match the caps (CONTRACTS.md section 7). */
export function formatResetTime(iso: string, now: Date = new Date()): string {
  const resetsAt = new Date(iso);
  const sameDay = (a: Date, b: Date) =>
    a.toLocaleDateString("en-GB", { timeZone: UK_TIME }) === b.toLocaleDateString("en-GB", { timeZone: UK_TIME });
  const time = resetsAt.toLocaleTimeString("en-GB", { timeZone: UK_TIME, hour: "2-digit", minute: "2-digit" });
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  if (sameDay(resetsAt, now)) return `today at ${time}`;
  if (sameDay(resetsAt, tomorrow)) return time === "00:00" ? "at midnight" : `tomorrow at ${time}`;
  return `on ${resetsAt.toLocaleDateString("en-GB", { timeZone: UK_TIME, day: "numeric", month: "long" })}`;
}

export interface ErrorCopy {
  title: string;
  message: string;
  kind: "cap" | "paused" | "signed_out" | "error";
}

/** Plain-English copy for an error from the API client (or anything else thrown). */
export function errorCopy(error: unknown): ErrorCopy {
  if (error instanceof ApiClientError) {
    switch (error.code) {
      case "daily_cap_reached": {
        const limit = error.cap?.limit;
        const when = error.cap ? ` You can add more ${formatResetTime(error.cap.resetsAt)}.` : "";
        if (error.cap?.kind === "link_fetches_per_day") {
          return {
            kind: "cap",
            title: "That's today's limit for links",
            message: `You've imported ${limit ?? "the most"} links today. You can still add items by photo.${when}`,
          };
        }
        return {
          kind: "cap",
          title: "That's today's limit",
          message: `You've added ${limit ?? "the most"} items today.${when}`,
        };
      }
      case "ai_paused": {
        const when = error.cap ? ` It starts again ${formatResetTime(error.cap.resetsAt)}.` : "";
        return {
          kind: "paused",
          title: "Adding is paused",
          message: `GladRags has reached its AI budget for this month, so adding items is paused. Your wardrobe still works.${when}`,
        };
      }
      case "unauthorized":
        // The API client is already on its way to /sign-in.
        return {
          kind: "signed_out",
          title: "You've been signed out",
          message: "Taking you to sign in. You'll come back here afterwards.",
        };
      case "ai_failed":
        return { kind: "error", title: "Tagging didn't work", message: "Our tagging service had a problem. Try again." };
      case "not_found":
        return { kind: "error", title: "Not found", message: error.message };
      default:
        return { kind: "error", title: "Something went wrong", message: error.message };
    }
  }
  if (error instanceof Error && error.name === "PhotoPrepError") {
    return { kind: "error", title: "Couldn't use that photo", message: error.message };
  }
  return { kind: "error", title: "Something went wrong", message: "Try again." };
}

export function ApiErrorNotice({ error, children }: { error: unknown; children?: React.ReactNode }) {
  const copy = errorCopy(error);
  const Icon = copy.kind === "cap" ? TimerIcon : copy.kind === "paused" ? PauseCircleIcon : copy.kind === "signed_out" ? LogInIcon : AlertCircleIcon;
  return (
    <Alert variant={copy.kind === "error" ? "destructive" : "default"} data-error-kind={copy.kind}>
      <Icon />
      <AlertTitle>{copy.title}</AlertTitle>
      <AlertDescription>
        <p>{copy.message}</p>
        {children}
      </AlertDescription>
    </Alert>
  );
}
