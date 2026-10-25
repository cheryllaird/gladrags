"use client";

import { useId, useRef, useState } from "react";
import { BookmarkIcon, HeartIcon, ThumbsDownIcon } from "lucide-react";
import { REJECT_REASON_MAX_LENGTH, type OutfitStatus, type UpdateOutfitStatusRequest } from "@/contracts";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

interface FeedbackBarProps {
  outfitName: string;
  status: OutfitStatus;
  busy: boolean;
  /** Hide "Reject" (e.g. on the saved outfits screen). */
  allowReject?: boolean;
  onChange: (update: UpdateOutfitStatusRequest) => void;
}

/**
 * Save, like and reject. An outfit has one status at a time, so saving a
 * liked outfit makes it saved, and tapping the active button again sets it
 * back to "suggested".
 */
export function FeedbackBar({ outfitName, status, busy, allowReject = true, onChange }: FeedbackBarProps) {
  const [rejectOpen, setRejectOpen] = useState(false);
  const rejectButtonRef = useRef<HTMLButtonElement>(null);

  const toggle = (target: "saved" | "liked") => onChange({ status: status === target ? "suggested" : target });

  return (
    <div className="flex gap-2" role="group" aria-label={`Feedback on ${outfitName}`}>
      <FeedbackButton
        label="Save"
        pressedLabel="Saved"
        pressed={status === "saved"}
        disabled={busy}
        onClick={() => toggle("saved")}
        icon={<BookmarkIcon aria-hidden className={cn(status === "saved" && "fill-current")} />}
      />
      <FeedbackButton
        label="Like"
        pressedLabel="Liked"
        pressed={status === "liked"}
        disabled={busy}
        onClick={() => toggle("liked")}
        icon={<HeartIcon aria-hidden className={cn(status === "liked" && "fill-current")} />}
      />
      {allowReject && (
        <FeedbackButton
          ref={rejectButtonRef}
          label="Reject"
          pressedLabel="Rejected"
          pressed={status === "rejected"}
          disabled={busy}
          onClick={() => setRejectOpen(true)}
          icon={<ThumbsDownIcon aria-hidden />}
        />
      )}
      <RejectDialog
        open={rejectOpen}
        outfitName={outfitName}
        onOpenChange={setRejectOpen}
        returnFocusTo={rejectButtonRef}
        onReject={(reason) => {
          setRejectOpen(false);
          onChange(reason ? { status: "rejected", reason } : { status: "rejected" });
        }}
      />
    </div>
  );
}

function FeedbackButton({
  ref,
  ...props
}: {
  ref?: React.Ref<HTMLButtonElement>;
  label: string;
  pressedLabel: string;
  pressed: boolean;
  disabled: boolean;
  icon: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <Button
      ref={ref}
      type="button"
      variant={props.pressed ? "default" : "outline"}
      aria-pressed={props.pressed}
      disabled={props.disabled}
      onClick={props.onClick}
      className="flex-1"
    >
      {props.icon}
      {props.pressed ? props.pressedLabel : props.label}
    </Button>
  );
}

function RejectDialog(props: {
  open: boolean;
  outfitName: string;
  onOpenChange: (open: boolean) => void;
  /** The dialog opens from state, not a DialogTrigger, so say where focus goes back to. */
  returnFocusTo: React.RefObject<HTMLButtonElement | null>;
  onReject: (reason: string | null) => void;
}) {
  const [reason, setReason] = useState("");
  const reasonId = useId();

  function submit(event: React.FormEvent) {
    event.preventDefault();
    // Single line only: the reason is sent to the model as an "avoid" hint.
    const clean = reason.replace(/\s+/g, " ").trim();
    props.onReject(clean || null);
    setReason("");
  }

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent
        showCloseButton={false}
        onCloseAutoFocus={(event) => {
          // After rejecting, the card collapses and the button is gone; then
          // let Radix choose.
          if (props.returnFocusTo.current?.isConnected) {
            event.preventDefault();
            props.returnFocusTo.current.focus();
          }
        }}
      >
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Not for you?</DialogTitle>
            <DialogDescription>
              We&apos;ll avoid pairings like {props.outfitName} next time. Saying why helps, but you can skip it.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor={reasonId}>Why not? (optional)</Label>
            <Textarea
              id={reasonId}
              value={reason}
              maxLength={REJECT_REASON_MAX_LENGTH}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. too formal, I'd never wear these together"
              rows={2}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => props.onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit">Reject outfit</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
