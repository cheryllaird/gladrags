"use client";

import { LinkIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import type { WardrobeItem } from "@/contracts";
import { PageBody, PageHeader } from "@/components/app-shell/page-header";
import { Button } from "@/components/ui/button";
import { ApiErrorNotice, errorCopy } from "@/components/wardrobe/api-error-notice";
import { DraftReview } from "@/components/wardrobe/add/draft-review";
import { PhotoPicker } from "@/components/wardrobe/add/photo-picker";
import { ProgressSteps } from "@/components/wardrobe/add/progress-steps";
import { SavedPanel } from "@/components/wardrobe/add/saved-panel";
import { UsageNote } from "@/components/wardrobe/add/usage-note";
import { usePreviewUrl } from "@/components/wardrobe/add/use-preview-url";
import { addingBlockedBy, useUsage } from "@/components/wardrobe/add/use-usage";
import { ADD_STAGE_LABELS, addByPhoto, type AddResult, type AddStage } from "@/lib/client/add-item";

const PHOTO_STEPS = (["preparing", "cutting_out", "uploading"] as const).map((id) => ({ id, label: ADD_STAGE_LABELS[id] }));

type Step =
  | { kind: "choose" }
  | { kind: "processing"; stage: AddStage }
  | { kind: "review"; result: AddResult }
  | { kind: "saved"; item: WardrobeItem }
  | { kind: "error"; error: unknown };

/** Add by photo: pick or take a photo, watch it process, review the tags, save, repeat. */
export function AddPhotoFlow() {
  const [step, setStep] = useState<Step>({ kind: "choose" });
  const [preview, setPreview] = usePreviewUrl();
  const { usage, refresh: refreshUsage } = useUsage();
  const blocked = addingBlockedBy(usage);

  function go(next: Step) {
    setStep(next);
    window.scrollTo({ top: 0 });
  }

  async function start(file: File) {
    setPreview(file);
    go({ kind: "processing", stage: "preparing" });
    try {
      const result = await addByPhoto(file, { onStage: (stage) => setStep({ kind: "processing", stage }) });
      go({ kind: "review", result });
    } catch (error) {
      go({ kind: "error", error });
    } finally {
      refreshUsage();
    }
  }

  const title = step.kind === "review" ? "Check the tags" : step.kind === "saved" ? "Saved" : "Add an item";

  return (
    <>
      <PageHeader title={title} />
      <PageBody className="space-y-5">
        {step.kind === "choose" && (
          <>
            <UsageNote usage={usage} />
            <div className="space-y-2">
              <p className="text-muted-foreground text-sm">
                One item per photo. Lay it flat or hang it up against a plain background.
              </p>
              <PhotoPicker onFile={(file) => void start(file)} disabled={blocked !== null} />
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

        {step.kind === "review" && (
          <DraftReview
            draft={step.result.draft}
            cutoutFailed={step.result.cutoutFailed}
            onSaved={(item) => {
              setPreview(null);
              go({ kind: "saved", item });
              refreshUsage();
            }}
            onDiscard={() => {
              setPreview(null);
              go({ kind: "choose" });
            }}
          />
        )}

        {step.kind === "saved" && (
          <SavedPanel item={step.item}>
            <PhotoPicker onFile={(file) => void start(file)} disabled={blocked !== null} />
            <Button asChild variant="link" className="w-full">
              <Link href="/add/link">Paste a link instead</Link>
            </Button>
          </SavedPanel>
        )}

        {step.kind === "error" && (
          <ErrorStep error={step.error} onRetry={() => go({ kind: "choose" })} />
        )}
      </PageBody>
    </>
  );
}

function ErrorStep({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const limited = errorCopy(error).kind !== "error";
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
