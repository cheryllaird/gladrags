"use client";

import { CameraIcon, ImageOffIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { SourceUrlSchema, type ItemTags, type LinkProduct, type WardrobeItem } from "@/contracts";
import { PageBody, PageHeader } from "@/components/app-shell/page-header";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiErrorNotice, errorCopy } from "@/components/wardrobe/api-error-notice";
import { DraftReview } from "@/components/wardrobe/add/draft-review";
import { notePhotoLost } from "@/components/wardrobe/add/pending-add";
import { PhotoPicker } from "@/components/wardrobe/add/photo-picker";
import { ProgressSteps } from "@/components/wardrobe/add/progress-steps";
import { RestoredNotice } from "@/components/wardrobe/add/restored-notice";
import { SavedPanel } from "@/components/wardrobe/add/saved-panel";
import { UsageNote } from "@/components/wardrobe/add/usage-note";
import { usePreviewUrl } from "@/components/wardrobe/add/use-preview-url";
import { useRestorePendingAdd } from "@/components/wardrobe/add/use-restore-pending-add";
import { addingBlockedBy, useUsage } from "@/components/wardrobe/add/use-usage";
import { ADD_STAGE_LABELS, addByPhoto, finishLinkImport, type AddResult, type AddStage } from "@/lib/client/add-item";
import { ApiClientError, importLink } from "@/lib/client/api";

type LinkStage = "fetching" | Exclude<AddStage, "preparing">;

const LINK_STEPS = [
  { id: "fetching", label: "Reading the product page" },
  { id: "cutting_out", label: ADD_STAGE_LABELS.cutting_out },
  { id: "uploading", label: ADD_STAGE_LABELS.uploading },
];
const SCREENSHOT_STEPS = (["preparing", "cutting_out", "uploading"] as const).map((id) => ({ id, label: ADD_STAGE_LABELS[id] }));

/** The screenshot fallback: which link it's for and what the server said. */
interface ScreenshotFor {
  sourceUrl: string;
  message: string;
}

type Step =
  | { kind: "enter"; invalid?: string }
  | { kind: "working"; stage: LinkStage; product: LinkProduct | null }
  | ({ kind: "screenshot" } & ScreenshotFor)
  | { kind: "screenshot_processing"; stage: AddStage; screenshot: ScreenshotFor }
  | { kind: "review"; result: AddResult; restoredTags?: ItemTags | null }
  | { kind: "saved"; item: WardrobeItem }
  // `screenshot` is set when the error came from the screenshot route, so
  // retrying goes back there (same link) rather than to the link box.
  | { kind: "error"; error: unknown; screenshot: ScreenshotFor | null };

/**
 * Add by link (CONTRACTS.md section 5): paste or share a product link; the
 * server reads the page and stores the product image; the phone cuts it
 * out and sends the cut-out for tagging. If the site can't be read, ask
 * for a screenshot, which goes down the photo route and keeps the link.
 */
export function AddLinkFlow({ initialUrl }: { initialUrl: string }) {
  const [url, setUrl] = useState(initialUrl);
  const [step, setStep] = useState<Step>({ kind: "enter" });
  const [preview, setPreview] = usePreviewUrl();
  const { usage, refresh: refreshUsage } = useUsage();
  const blocked = addingBlockedBy(usage);
  const id = useId();
  const autoStarted = useRef(false);
  // Shown after signing in again, if the session expired mid-add.
  const [restored, setRestored] = useState<"draft" | "photo_lost" | null>(null);

  function go(next: Step) {
    setStep(next);
    window.scrollTo({ top: 0 });
  }

  async function start(link: string) {
    const parsed = SourceUrlSchema.safeParse(link.trim());
    if (!parsed.success) {
      go({ kind: "enter", invalid: "Paste a full link starting with https://" });
      return;
    }
    go({ kind: "working", stage: "fetching", product: null });
    try {
      const imported = await importLink(parsed.data);
      if (imported.status === "needs_screenshot") {
        go({ kind: "screenshot", sourceUrl: imported.sourceUrl, message: imported.message });
        return;
      }
      setStep({ kind: "working", stage: "cutting_out", product: imported.product });
      const result = await finishLinkImport(imported, {
        onStage: (stage) => setStep({ kind: "working", stage: stage === "preparing" ? "cutting_out" : stage, product: imported.product }),
      });
      go({ kind: "review", result });
    } catch (error) {
      go({ kind: "error", error, screenshot: null });
    } finally {
      refreshUsage();
    }
  }

  async function startScreenshot(file: File, screenshot: ScreenshotFor) {
    setPreview(file);
    setRestored(null);
    go({ kind: "screenshot_processing", stage: "preparing", screenshot });
    try {
      const result = await addByPhoto(file, {
        sourceUrl: screenshot.sourceUrl,
        onStage: (stage) => setStep({ kind: "screenshot_processing", stage, screenshot }),
      });
      go({ kind: "review", result });
    } catch (error) {
      if (error instanceof ApiClientError && error.code === "unauthorized") notePhotoLost();
      go({ kind: "error", error, screenshot });
    } finally {
      refreshUsage();
    }
  }

  // Back from sign-in after the session expired mid-add: reopen what was kept.
  // (Declared before the auto-start effect below, so it runs first.)
  useRestorePendingAdd((pending) => {
    autoStarted.current = true;
    setRestored(pending.kind);
    if (pending.kind === "draft") {
      go({ kind: "review", result: { draft: pending.draft, cutoutFailed: pending.cutoutFailed }, restoredTags: pending.tags });
    }
  });

  // Shared to GladRags from another app (PWA share target): start straight away.
  useEffect(() => {
    if (initialUrl && !autoStarted.current) {
      autoStarted.current = true;
      void start(initialUrl);
    }
    // Runs once, for what the page opened with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Start over with an empty link box (a new link). */
  function reset() {
    setPreview(null);
    setRestored(null);
    setUrl("");
    go({ kind: "enter" });
  }

  /** Try again after an error, keeping the link (and the screenshot step, if that's where it failed). */
  function retry(screenshot: ScreenshotFor | null) {
    setPreview(null);
    go(screenshot ? { kind: "screenshot", ...screenshot } : { kind: "enter" });
  }

  function saved(item: WardrobeItem) {
    setPreview(null);
    setRestored(null);
    // A shared link arrives as ?url=… (or ?text=…); clear it so a reload doesn't import it again.
    if (window.location.search) window.history.replaceState(null, "", window.location.pathname);
    go({ kind: "saved", item });
    refreshUsage();
  }

  const title =
    step.kind === "review" ? "Check the tags" : step.kind === "saved" ? "Saved" : step.kind === "screenshot" ? "Add a screenshot" : "Add by link";

  return (
    <>
      <PageHeader title={title} backHref="/add" backLabel="Back to add" />
      <PageBody className="space-y-5">
        {restored && <RestoredNotice kind={restored} />}

        {step.kind === "enter" && (
          <>
            <UsageNote usage={usage} />
            <form
              className="space-y-3"
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                void start(url);
              }}
            >
              <Label htmlFor={`${id}-url`}>Product link</Label>
              <Input
                id={`${id}-url`}
                type="url"
                inputMode="url"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                enterKeyHint="go"
                placeholder="https://shop.example.com/…"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                aria-invalid={step.invalid ? true : undefined}
                aria-describedby={step.invalid ? `${id}-url-error` : `${id}-url-hint`}
              />
              {step.invalid ? (
                <p id={`${id}-url-error`} className="text-destructive text-sm">
                  {step.invalid}
                </p>
              ) : (
                <p id={`${id}-url-hint`} className="text-muted-foreground text-xs">
                  Copy the link from the shop&apos;s product page and paste it here.
                </p>
              )}
              <Button type="submit" size="lg" className="w-full" disabled={blocked !== null || url.trim() === ""}>
                Add from link
              </Button>
            </form>
          </>
        )}

        {step.kind === "working" && (
          <div className="space-y-4">
            {step.product?.title && (
              <p className="text-center text-sm">
                <span className="font-medium">{step.product.title}</span>
                {step.product.brand && <span className="text-muted-foreground"> · {step.product.brand}</span>}
              </p>
            )}
            <ProgressSteps steps={LINK_STEPS} current={step.stage} />
          </div>
        )}

        {step.kind === "screenshot" && (
          <div className="space-y-4">
            <Alert>
              <ImageOffIcon />
              <AlertDescription>
                <p>{step.message}</p>
              </AlertDescription>
            </Alert>
            <p className="text-muted-foreground text-sm">
              Screenshot the product on the shop&apos;s page, then choose it here. We&apos;ll keep the link with the item.
            </p>
            <PhotoPicker
              libraryFirst
              libraryLabel="Choose a screenshot"
              cameraLabel="Take a photo instead"
              disabled={blocked !== null}
              onFile={(file) => void startScreenshot(file, { sourceUrl: step.sourceUrl, message: step.message })}
            />
            <Button variant="link" className="w-full" onClick={reset}>
              Try a different link
            </Button>
          </div>
        )}

        {step.kind === "screenshot_processing" && <ProgressSteps steps={SCREENSHOT_STEPS} current={step.stage} preview={preview} />}

        {step.kind === "review" && (
          <DraftReview
            draft={step.result.draft}
            cutoutFailed={step.result.cutoutFailed}
            restoredTags={step.restoredTags}
            onSaved={saved}
            onDiscard={reset}
          />
        )}

        {step.kind === "saved" && (
          <SavedPanel item={step.item}>
            <Button size="lg" className="w-full" onClick={reset}>
              Paste another link
            </Button>
            <Button asChild size="lg" variant="outline" className="w-full">
              <Link href="/add">
                <CameraIcon aria-hidden="true" />
                Add by photo
              </Link>
            </Button>
          </SavedPanel>
        )}

        {step.kind === "error" && (
          <LinkError error={step.error} fromScreenshot={step.screenshot !== null} onRetry={() => retry(step.screenshot)} />
        )}
      </PageBody>
    </>
  );
}

function LinkError({ error, fromScreenshot, onRetry }: { error: unknown; fromScreenshot: boolean; onRetry: () => void }) {
  const { kind } = errorCopy(error);
  // Signed out: already on the way to sign-in, so there's nothing to tap.
  if (kind === "signed_out") return <ApiErrorNotice error={error} />;
  const limited = kind === "cap" || kind === "paused";
  // Step 2 found the import expired or used: starting again with the same link fixes it.
  const expired = error instanceof ApiClientError && error.code === "not_found";
  return (
    <div className="space-y-4">
      <ApiErrorNotice error={error} />
      {limited ? (
        <Button asChild size="lg" className="w-full">
          <Link href="/wardrobe">Go to wardrobe</Link>
        </Button>
      ) : (
        <Button size="lg" className="w-full" onClick={onRetry}>
          {fromScreenshot ? "Try another screenshot" : expired ? "Paste the link again" : "Try again"}
        </Button>
      )}
    </div>
  );
}
