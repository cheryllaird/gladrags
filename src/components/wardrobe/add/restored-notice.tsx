import { LogInIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { PendingAdd } from "./pending-add";

/** After signing in again: what happened to the item being added when the session expired. */
export function RestoredNotice({ kind }: { kind: PendingAdd["kind"] }) {
  return (
    <Alert data-restored={kind}>
      <LogInIcon />
      <AlertTitle>You were signed out</AlertTitle>
      <AlertDescription>
        {kind === "draft"
          ? "We kept the item you were adding. Check the tags and save it."
          : "The photo you'd chosen didn't upload in time. Choose it again to carry on."}
      </AlertDescription>
    </Alert>
  );
}
