import { PauseCircleIcon, TimerIcon } from "lucide-react";
import type { UsageSummary } from "@/contracts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { formatResetTime } from "../api-error-notice";
import { addingBlockedBy } from "./use-usage";

/** "3 of 40 items added today", or why adding is blocked. */
export function UsageNote({ usage }: { usage: UsageSummary | null }) {
  if (!usage) return null;
  const blocked = addingBlockedBy(usage);
  if (blocked === "paused") {
    return (
      <Alert data-error-kind="paused">
        <PauseCircleIcon />
        <AlertTitle>Adding is paused</AlertTitle>
        <AlertDescription>
          GladRags has reached its AI budget for this month, so adding items is paused until next month. Your wardrobe still works.
        </AlertDescription>
      </Alert>
    );
  }
  if (blocked === "cap") {
    return (
      <Alert data-error-kind="cap">
        <TimerIcon />
        <AlertTitle>That&apos;s today&apos;s limit</AlertTitle>
        <AlertDescription>
          You&apos;ve added {usage.itemsToday.limit} items today. You can add more {formatResetTime(usage.dailyResetAt)}.
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <p className="text-muted-foreground text-center text-xs">
      {usage.itemsToday.used} of {usage.itemsToday.limit} items added today
    </p>
  );
}
