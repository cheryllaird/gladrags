"use client";

import { CircleUserIcon, LogOutIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { ApiErrorNotice } from "@/components/wardrobe/api-error-notice";
import { deleteAccount } from "@/lib/client/api";

/** Where to go once the account is gone. Tests replace it. */
export const accountNavigation = {
  toSignIn(): void {
    // A full page load on purpose: nothing from the deleted account stays in memory.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.assign("/sign-in");
  },
};

/**
 * The signed-in user's account (spec: Privacy, "Users can ... delete their
 * whole account and data"): their email, Sign out, and Delete my account
 * behind a confirmation. Opens from the icon in the wardrobe header.
 */
export function AccountSheet({ email }: { email: string | null }) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function confirmDelete() {
    setDeleting(true);
    setError(null);
    try {
      await deleteAccount();
      accountNavigation.toSignIn();
    } catch (err) {
      setError(err);
      setDeleting(false);
    }
  }

  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Account">
          <CircleUserIcon className="size-6" aria-hidden="true" />
        </Button>
      </SheetTrigger>
      <SheetContent side="bottom" className="mx-auto max-w-md rounded-t-xl pb-[max(env(safe-area-inset-bottom),1rem)]">
        <SheetHeader>
          <SheetTitle>Account</SheetTitle>
          <SheetDescription>{email ? <>Signed in as {email}</> : "Signed in"}</SheetDescription>
        </SheetHeader>
        <div className="grid gap-2 px-4">
          <form action="/api/auth/sign-out" method="post">
            <Button type="submit" variant="outline" size="lg" className="w-full">
              <LogOutIcon aria-hidden="true" />
              Sign out
            </Button>
          </form>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="ghost" size="lg" className="text-destructive w-full" disabled={deleting}>
                <Trash2Icon aria-hidden="true" />
                {deleting ? "Deleting your account…" : "Delete my account"}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete your account?</AlertDialogTitle>
                <AlertDialogDescription>
                  This deletes your account and everything in it: all your photos, every item in your wardrobe and all
                  your outfits, saved ones included. You can&apos;t undo this.
                </AlertDialogDescription>
              </AlertDialogHeader>
              {error !== null && <ApiErrorNotice error={error} />}
              <AlertDialogFooter>
                <AlertDialogCancel>Keep my account</AlertDialogCancel>
                {/* A plain button, not AlertDialogAction, so the dialog stays open if deleting fails. */}
                <Button variant="destructive" disabled={deleting} onClick={() => void confirmDelete()}>
                  {deleting ? "Deleting…" : "Delete everything"}
                </Button>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </SheetContent>
    </Sheet>
  );
}
