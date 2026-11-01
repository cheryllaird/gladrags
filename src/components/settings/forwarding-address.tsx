"use client";

import { CopyIcon, MailIcon, RefreshCwIcon } from "lucide-react";
import { useRef, useState } from "react";
import type { UserSettings } from "@/contracts";
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
import { ApiErrorNotice } from "@/components/wardrobe/api-error-notice";
import { resetForwardingAddress } from "@/lib/client/api";

/**
 * The user's private address for forwarding order emails (spec: Add by
 * forwarding order emails): copy it, how to use it, and a reset that
 * confirms first. Null address: the app has no inbound email set up yet.
 */
export function ForwardingAddress({
  address,
  email,
  onReset,
}: {
  address: string | null;
  /** The sign-in address emails must be forwarded from. */
  email: string | null;
  onReset: (settings: UserSettings) => void;
}) {
  const [copied, setCopied] = useState<"copied" | "select" | null>(null);
  const [open, setOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const addressRef = useRef<HTMLParagraphElement>(null);
  const from = email ?? "your sign-in address";

  async function copy(value: string) {
    setNotice(null);
    try {
      await navigator.clipboard.writeText(value);
      setCopied("copied");
    } catch {
      // No clipboard access (older browser, or permission refused): select it to copy by hand.
      const node = addressRef.current;
      const selection = window.getSelection();
      if (node && selection) {
        const range = document.createRange();
        range.selectNodeContents(node);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      setCopied("select");
    }
  }

  async function reset() {
    setResetting(true);
    setError(null);
    try {
      const settings = await resetForwardingAddress();
      onReset(settings);
      setCopied(null);
      setNotice("You have a new address. The old one no longer works.");
      setOpen(false);
    } catch (err) {
      setError(err);
    } finally {
      setResetting(false);
    }
  }

  return (
    <section id="order-emails" aria-labelledby="forwarding-heading" className="scroll-mt-20 space-y-3">
      <div className="space-y-1">
        <h2 id="forwarding-heading" className="font-semibold">
          Add items from order emails
        </h2>
        <p className="text-muted-foreground text-sm">
          Forward order confirmation emails from {from} to your own GladRags address. We add the clothes and shoes in them to
          your wardrobe, marked to review.
        </p>
      </div>

      {address === null ? (
        <p className="bg-muted rounded-md px-3 py-2 text-sm">Email import isn&apos;t set up yet. Check back soon.</p>
      ) : (
        <>
          <div className="space-y-2 rounded-lg border p-3">
            <p className="text-muted-foreground flex items-center gap-2 text-xs">
              <MailIcon className="size-4" aria-hidden="true" />
              Your forwarding address
            </p>
            <p ref={addressRef} className="font-mono text-sm break-all select-all" data-testid="forwarding-address">
              {address}
            </p>
            <Button size="lg" variant="outline" className="w-full" onClick={() => void copy(address)}>
              <CopyIcon aria-hidden="true" />
              {copied === "copied" ? "Copied" : "Copy address"}
            </Button>
            {copied && (
              <p role="status" className="text-muted-foreground text-xs">
                {copied === "copied" ? "Copied. Paste it into the To box when you forward an email." : "Selected: copy it from the menu."}
              </p>
            )}
          </div>

          <ol className="text-muted-foreground list-decimal space-y-1 pl-5 text-sm">
            <li>Open an order confirmation email from a shop.</li>
            <li>Forward it to the address above, from {from}.</li>
            <li>The items appear in your wardrobe, ready to review, usually within a minute or two.</li>
          </ol>
          <p className="text-muted-foreground text-xs">
            Only emails forwarded from {from} are added, and they count towards your daily limits.
          </p>

          {notice && (
            <p role="status" className="bg-muted rounded-md px-3 py-2 text-sm">
              {notice}
            </p>
          )}

          <AlertDialog open={open} onOpenChange={(next) => !resetting && setOpen(next)}>
            <AlertDialogTrigger asChild>
              <Button variant="ghost" size="lg" className="w-full">
                <RefreshCwIcon aria-hidden="true" />
                Get a new address
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Get a new forwarding address?</AlertDialogTitle>
                <AlertDialogDescription>
                  Your current address stops working straight away, so emails sent to it won&apos;t be added. Do this if you
                  think someone else has it.
                </AlertDialogDescription>
              </AlertDialogHeader>
              {error !== null && <ApiErrorNotice error={error} />}
              <AlertDialogFooter>
                <AlertDialogCancel disabled={resetting}>Keep this address</AlertDialogCancel>
                {/* A plain button, so the dialog stays open if the reset fails. */}
                <Button disabled={resetting} onClick={() => void reset()}>
                  {resetting ? "Getting a new address…" : "Get a new address"}
                </Button>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      )}
    </section>
  );
}
