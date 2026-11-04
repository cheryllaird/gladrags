"use client";

import { CameraIcon, ImageOffIcon, InfoIcon, ListChecksIcon, PlusIcon } from "lucide-react";
import Link from "next/link";
import { useId, useState } from "react";
import type { ItemTags, LinkProduct, WardrobeItem } from "@/contracts";
import { PageBody, PageHeader } from "@/components/app-shell/page-header";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
  addLinksForReview,
  addScreenshotForReview,
  extractLinks,
  finishLinkImport,
  type AddResult,
  type AddStage,
  type BatchEntryState,
} from "@/lib/client/add-item";
import { ApiClientError, importLink } from "@/lib/client/api";

type LinkStage = "fetching" | "tagging";

const LINK_STEPS = [
  { id: "fetching", label: "Reading the product page" },
  { id: "tagging", label: "Tagging the item" },
];
const SCREENSHOT_STEPS = (["preparing", "uploading"] as const).map((id) => ({ id, label: ADD_STAGE_LABELS[id] }));

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
  | { kind: "error"; error: unknown; screenshot: ScreenshotFor | null }
  /** Several links pasted at once: imported one after another as "to review". */
  | { kind: "batch" };

/**
 * Add by link (CONTRACTS.md section 5): paste or share a product link; the
 * server reads the page, stores the product image and tags it. If the
 * site can't be read, ask for a screenshot, which goes down the photo
 * route and keeps the link.
 *
 * Several links pasted at once (one per line, or a block of text with
 * links in it) are imported one after another and saved as "to review";
 * those that need a screenshot are listed at the end, each with a way to
 * add one.
 */
export function AddLinkFlow({
  sharedUrl,
  userId,
}: {
  /** A link shared to the installed app (PWA share target), or "". Filled in, never imported without a tap. */
  sharedUrl: string;
  /** The signed-in user, for a draft kept when the session expires (pending-add.ts). */
  userId: string | null;
}) {
  const [url, setUrl] = useState(sharedUrl);
  // Arrived with a shared link: while the box still holds it, the button
  // says what it will do with it. Editing it, or starting over, goes back
  // to the ordinary label.
  const [fromShare, setFromShare] = useState(sharedUrl !== "");
  const shared = fromShare && url.trim() === sharedUrl;
  const [step, setStep] = useState<Step>({ kind: "enter" });
  const [preview, setPreview] = usePreviewUrl();
  const { usage, refresh: refreshUsage } = useUsage();
  const blocked = addingBlockedBy(usage);
  const { batch, run: runBatch, setRow, clear: clearBatch } = useBatch(userId, "link");
  const found = extractLinks(url);
  const id = useId();
  // Shown after signing in again, if the session expired mid-add.
  const [restored, setRestored] = useState<"draft" | "photo_lost" | null>(null);

  function go(next: Step) {
    setStep(next);
    window.scrollTo({ top: 0 });
  }

  function submit(text: string) {
    const { links, extra } = extractLinks(text);
    if (links.length === 0) {
      go({ kind: "enter", invalid: "Paste a full link starting with https://" });
      return;
    }
    if (links.length === 1) void start(links[0]!);
    else void startBatch(links, extra);
  }

  async function start(link: string) {
    go({ kind: "working", stage: "fetching", product: null });
    try {
      const imported = await importLink(link);
      if (imported.status === "needs_screenshot") {
        go({ kind: "screenshot", sourceUrl: imported.sourceUrl, message: imported.message });
        return;
      }
      setStep({ kind: "working", stage: "tagging", product: imported.product });
      const result = await finishLinkImport(imported);
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
      if (error instanceof ApiClientError && error.code === "unauthorized") notePhotoLost(userId);
      go({ kind: "error", error, screenshot });
    } finally {
      refreshUsage();
    }
  }

  async function startBatch(links: string[], extra: number) {
    setRestored(null);
    go({ kind: "batch" });
    await runBatch(links.map(linkLabel), extra, (onChange, signal) => addLinksForReview(links, onChange, undefined, signal));
    refreshUsage();
  }

  /** A screenshot for one link of the batch that needed the fallback. */
  async function batchScreenshot(index: number, file: File, screenshot: ScreenshotFor) {
    setRow(index, { kind: "pending", stage: "uploading" });
    try {
      setRow(index, await addScreenshotForReview(file, screenshot.sourceUrl));
    } catch (error) {
      // Leave it waiting for a screenshot, saying what went wrong, so it can be tried again.
      setRow(index, { kind: "needs_screenshot", sourceUrl: screenshot.sourceUrl, message: `${errorCopy(error).message} ${screenshot.message}` });
    } finally {
      refreshUsage();
    }
  }

  // Back from sign-in after the session expired mid-add: reopen what was kept.
  useRestorePendingAdd(userId, (pending) => {
    setRestored(pending.kind);
    if (pending.kind === "draft") {
      go({ kind: "review", result: { draft: pending.draft }, restoredTags: pending.tags });
    }
  });

  /** Start over with an empty link box (a new link). */
  function reset() {
    setPreview(null);
    setRestored(null);
    setUrl("");
    setFromShare(false);
    clearBatch();
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
    // A shared link arrives as ?url=… (or ?text=…); clear it so a reload doesn't offer it again.
    if (window.location.search) window.history.replaceState(null, "", window.location.pathname);
    go({ kind: "saved", item });
    refreshUsage();
  }

  const title =
    step.kind === "review"
      ? "Check the tags"
      : step.kind === "saved"
        ? "Saved"
        : step.kind === "screenshot"
          ? "Add a screenshot"
          : step.kind === "batch"
            ? "Adding links"
            : "Add by link";
  const submitLabel = shared ? "Import this link" : found.links.length > 1 ? `Add ${found.links.length} links` : "Add from link";

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
                submit(url);
              }}
            >
              <Label htmlFor={`${id}-url`}>Product links</Label>
              <Textarea
                id={`${id}-url`}
                inputMode="url"
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                rows={3}
                maxLength={20000}
                placeholder="https://shop.example.com/…"
                className="max-h-64 min-h-24 text-base break-all"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                aria-invalid={step.invalid ? true : undefined}
                aria-describedby={step.invalid ? `${id}-url-error` : `${id}-url-hint`}
              />
              {step.invalid ? (
                <p id={`${id}-url-error`} className="text-destructive text-sm">
                  {step.invalid}
                </p>
              ) : shared ? (
                <p id={`${id}-url-hint`} className="text-muted-foreground text-xs">
                  Shared to GladRags. Check it&apos;s the product you meant, then import it.
                </p>
              ) : (
                <p id={`${id}-url-hint`} className="text-muted-foreground text-xs">
                  Copy the link from the shop&apos;s product page and paste it here. To add several, paste them all: one per
                  line, or any text with links in it.
                  {found.links.length > 1 && (
                    <span className="text-foreground block pt-1 font-medium">
                      {found.links.length} different links found{found.extra > 0 ? ` (the first ${MAX_BATCH_SIZE}; add the other ${found.extra} in another go)` : ""}.
                    </span>
                  )}
                </p>
              )}
              <Button type="submit" size="lg" className="w-full" disabled={blocked !== null || url.trim() === ""}>
                {submitLabel}
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

        {step.kind === "batch" && batch && (
          <LinkBatch
            batch={batch}
            onScreenshot={(index, file) => {
              const row = batch.rows[index]?.state;
              if (row?.kind === "needs_screenshot") void batchScreenshot(index, file, { sourceUrl: row.sourceUrl, message: row.message });
            }}
            userId={userId}
            onRowChange={setRow}
            onAddMore={reset}
          />
        )}

        {step.kind === "review" && (
          <DraftReview
            userId={userId}
            draft={step.result.draft}
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

/** A short label for a link in the batch list: the shop's host and the page's path. */
function linkLabel(link: string): string {
  try {
    const url = new URL(link);
    return `${url.hostname.replace(/^www\./, "")}${url.pathname === "/" ? "" : url.pathname}`;
  } catch {
    return link;
  }
}

function LinkBatch({
  batch,
  onScreenshot,
  userId,
  onRowChange,
  onAddMore,
}: {
  batch: BatchState;
  onScreenshot: (index: number, file: File) => void;
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
            You can add up to {MAX_BATCH_SIZE} links at once, so the other {batch.extra} weren&apos;t included. Add them in another go.
          </AlertDescription>
        </Alert>
      )}
      <BatchProgress
        kind="link"
        userId={userId}
        onRowChange={onRowChange}
        rows={batch.rows}
        running={batch.running}
        stoppedBy={batch.stoppedBy}
        onScreenshot={onScreenshot}
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
              Paste more links
            </Button>
          </>
        }
      />
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
