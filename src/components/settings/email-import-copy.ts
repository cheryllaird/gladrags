import type { EmailImport, EmailImportError } from "@/contracts";

/** Why an email (or some of its items) couldn't be added, in plain English. */
export const EMAIL_IMPORT_REASONS: Record<EmailImportError, string> = {
  sender_not_allowed: "It wasn't forwarded from your sign-in address.",
  failed_checks: "It didn't pass the email security checks.",
  no_items_found: "We couldn't find any clothes or shoes in it.",
  daily_cap_reached: "Today's limit for adding items was reached. Forward it again tomorrow.",
  ai_paused: "Adding is paused until next month.",
  ai_failed: "We couldn't read it. Try forwarding it again.",
  internal: "Something went wrong on our side. Try forwarding it again.",
};

const count = (n: number) => (n === 1 ? "1 item" : `${n} items`);

/** "Added 3 items", "Couldn't be added", and the reason if there is one. */
export function emailImportStatus(entry: Pick<EmailImport, "status" | "itemCount" | "skippedCount" | "error">): {
  summary: string;
  reason: string | null;
} {
  const reason = entry.error ? EMAIL_IMPORT_REASONS[entry.error] : null;
  switch (entry.status) {
    case "processing":
      return { summary: "Adding the items…", reason: null };
    case "failed":
      return { summary: "Couldn't be added", reason };
    case "done": {
      const summary = entry.itemCount === 0 ? "No items added" : `Added ${count(entry.itemCount)} to review`;
      if (entry.skippedCount > 0) return { summary: `${summary}; ${count(entry.skippedCount)} left out`, reason };
      return { summary, reason: entry.itemCount === 0 ? reason : null };
    }
  }
}

/** "31 Oct" (UK), for when the email arrived. */
export function formatImportDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { timeZone: "Europe/London", day: "numeric", month: "short" });
}
