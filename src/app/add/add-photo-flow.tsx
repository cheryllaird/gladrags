"use client";

import { InfoIcon, LinkIcon, ListChecksIcon, PlusIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import type { ItemTags, WardrobeItem } from "@/contracts";
import { PageBody, PageHeader } from "@/components/app-shell/page-header";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ApiErrorNotice, errorCopy } from "@/components/wardrobe/api-error-notice";
import { BatchProgress } from "@/components/wardrobe/add/batch-progress";
import { DraftReview } from "@/components/wardrobe/add/draft-review";
import { notePhotoLost } from "@/components/wardrobe/add/pending-add";
import { PhotoPicker } from "@/components/wardrobe/add/photo-picker";
import { ProgressSteps } from "@/components/wardrobe/add/progress-steps";
import { RestoredNotice } from "@/components/wardrobe/add/restored-notice";
import { SavedPanel } from "@/components/wardrobe/add/saved-panel";
import { UsageNote } from "@/components/wardrobe/add/usage-note";
import { usePreviewUrl } from "@/components/wardrobe/add/use-preview-url";
import { useBatch, type BatchState } from "@/components/wardrobe/add/use-batch";
import { useRestorePendingAdd } from "@/components/wardrobe/add/use-restore-pending-add";
import { addingBlockedBy, useUsage } from "@/components/wardrobe/add/use-usage";
import {
  ADD_STAGE_LABELS,
  MAX_BATCH_SIZE,
  addByPhoto,
  addPhotosForReview,
  type AddResult,
  type AddStage,
  type BatchEntryState,
} from "@/lib/client/add-item";
import { ApiClientError } from "@/lib/client/api";

const PHOTO_STEPS = (["preparing", "uploading"] as const).map((id) => ({ id, label: ADD_STAGE_LABELS[id] }));

type Step =
  | { kind: "choose" }
  | { kind: "processing"; stage: AddStage }
  | { kind: "review"; result: AddResult; restoredTags?: ItemTags | null }
  | { kind: "saved"; item: WardrobeItem }
  | { kind: "error"; error: unknown }
  /** Several photos from the library: saved one after another as "to review". */
  | { kind: "batch" };

/**
 * Add by photo. One photo: watch it process, review the tags, save,
 * repeat. Several from the library: each is uploaded in turn and saved
 * straight away as "to review", with per-photo progress and a summary
 * (spec: Add by photo, step 5). No background removal while adding.
 */
export function AddPhotoFlow({ userId }: { userId: string | null }) {
  const [step, setStep] = useState<Step>({ kind: "choose" });
  const [preview, setPreview] = usePreviewUrl();
  const { usage, refresh: refreshUsage } = useUsage();
  const blocked = addingBlockedBy(usage);
  const { batch, run: runBatch, setRow, clear: clearBatch } = useBatch(userId, "photo");
  // Shown after signing in again, if the session expired mid-add.
  const [restored, setRestored] = useState<"draft" | "photo_lost" | null>(null);

  useRestorePendingAdd(userId, (pending) => {
    setRestored(pending.kind);
    if (pending.kind === "draft") {
      go({ kind: "review", result: { draft: pending.draft }, restoredTags: pending.tags });
    }
  });

  function go(next: Step) {
    setStep(next);
    window.scrollTo({ top: 0 });
  }

  async function start(file: File) {
    setPreview(file);
    setRestored(null);
    go({ kind: "processing", stage: "preparing" });
    try {
      const result = await addByPhoto(file, { onStage: (stage) => setStep({ kind: "processing", stage }) });
      go({ kind: "review", result });
    } catch (error) {
      // Signed out before the photo reached us: it can't be kept, so say so after sign-in.
      if (error instanceof ApiClientError && error.code === "unauthorized") notePhotoLost(userId);
      go({ kind: "error", error });
    } finally {
      refreshUsage();
    }
  }

  async function startBatch(files: File[]) {
    setPreview(null);
    setRestored(null);
    go({ kind: "batch" });
    const chosen = files.slice(0, MAX_BATCH_SIZE);
    await runBatch(
      chosen.map((_, i) => `Photo ${i + 1}`),
      files.length - chosen.length,
      (onChange, signal) => addPhotosForReview(chosen, onChange, undefined, signal),
    );
    refreshUsage();
  }

  function backToChoose() {
    setRestored(null);
    setPreview(null);
    clearBatch();
    go({ kind: "choose" });
  }

  const title =
    step.kind === "review" ? "Check the tags" : step.kind === "saved" ? "Saved" : step.kind === "batch" ? "Adding photos" : "Add an item";
  const picker = (
    <PhotoPicker onFile={(file) => void start(file)} onFiles={(files) => void startBatch(files)} disabled={blocked !== null} />
  );

  return (
    <>
      <PageHeader title={title} />
      <PageBody className="space-y-5">
        {restored && <RestoredNotice kind={restored} />}

        {step.kind === "choose" && (
          <>
            <UsageNote usage={usage} />
            <div className="space-y-2">
              <p className="text-muted-foreground text-sm">
                One item per photo. Lay it flat or hang it up against a plain background.
              </p>
              {picker}
              <p className="text-muted-foreground text-xs">
                Choose several photos from your library to add them all at once. You check their tags afterwards.
              </p>
            </div>
            <Divider />
            <Button asChild size="lg" variant="outline" className="w-full">
              <Link href="/add/link">
                <LinkIcon aria-hidden="true" />
                Paste a product link
              </Link>
            </Button>
          </>
        )}

        {step.kind === "processing" && <ProgressSteps steps={PHOTO_STEPS} current={step.stage} preview={preview} />}

        {step.kind === "batch" && batch && <PhotoBatch batch={batch} userId={userId} onRowChange={setRow} onAddMore={backToChoose} />}

        {step.kind === "review" && (
          <DraftReview
            userId={userId}
            draft={step.result.draft}
            restoredTags={step.restoredTags}
            onSaved={(item) => {
              setRestored(null);
              setPreview(null);
              go({ kind: "saved", item });
              refreshUsage();
            }}
            onDiscard={backToChoose}
          />
        )}

        {step.kind === "saved" && (
          <SavedPanel item={step.item}>
            {picker}
            <Button asChild variant="link" className="w-full">
              <Link href="/add/link">Paste a link instead</Link>
            </Button>
          </SavedPanel>
        )}

        {step.kind === "error" && <ErrorStep error={step.error} onRetry={backToChoose} />}
      </PageBody>
    </>
  );
}

function PhotoBatch({
  batch,
  userId,
  onRowChange,
  onAddMore,
}: {
  batch: BatchState;
  userId: string | null;
  onRowChange: (index: number, state: BatchEntryState) => void;
  onAddMore: () => void;
}) {
  const reviewable = batch.rows.some((row) => row.state.kind === "saved" || row.state.kind === "draft");
  return (
    <>
      {batch.extra > 0 && (
        <Alert>
          <InfoIcon />
          <AlertDescription>
            You can add up to {MAX_BATCH_SIZE} photos at once, so the other {batch.extra} weren&apos;t included. Add them in another go.
          </AlertDescription>
        </Alert>
      )}
      <BatchProgress
        kind="photo"
        userId={userId}
        onRowChange={onRowChange}
        rows={batch.rows}
        running={batch.running}
        stoppedBy={batch.stoppedBy}
        actions={
          <>
            {reviewable && (
              <Button asChild size="lg">
                <Link href="/wardrobe/review">
                  <ListChecksIcon aria-hidden="true" />
                  Review new items
                </Link>
              </Button>
            )}
            <Button size="lg" variant={reviewable ? "outline" : "default"} onClick={onAddMore}>
              <PlusIcon aria-hidden="true" />
              Add more
            </Button>
          </>
        }
      />
    </>
  );
}

function ErrorStep({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const { kind } = errorCopy(error);
  // Signed out: already on the way to sign-in, so there's nothing to tap.
  if (kind === "signed_out") return <ApiErrorNotice error={error} />;
  const limited = kind === "cap" || kind === "paused";
  return (
    <div className="space-y-4">
      <ApiErrorNotice error={error} />
      <div className="grid gap-2">
        {limited ? (
          <Button asChild size="lg">
            <Link href="/wardrobe">Go to wardrobe</Link>
          </Button>
        ) : (
          <Button size="lg" onClick={onRetry}>
            Try another photo
          </Button>
        )}
      </div>
    </div>
  );
}

function Divider() {
  return (
    <div className="text-muted-foreground flex items-center gap-3 text-xs" aria-hidden="true">
      <span className="bg-border h-px flex-1" />
      or
      <span className="bg-border h-px flex-1" />
    </div>
  );
}
