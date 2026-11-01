/**
 * The add-item pipelines the screens run, step by step:
 *
 * Photo:  prepare (resize to 1600 px + JPEG, which also handles HEIC) -> upload + tag
 * Link:   step 1 (importLink: the server reads the page) -> step 2 (tag the stored image)
 *
 * Since milestone 5 there's no background removal while adding: the
 * wardrobe shows the original, and a collage cuts the item out the first
 * time it needs it (spec: Building the wardrobe).
 *
 * Batches (several photos or links) run one after another with
 * `saveForReview`, so each item is saved straight away as "to review".
 * Dependencies are parameters so the pipelines can be unit-tested without
 * a browser.
 */
import { SourceUrlSchema, type BatchAddResponse, type ItemDraft, type LinkImportResponse, type WardrobeItem } from "@/contracts";
import {
  ApiClientError,
  finishLink,
  finishLinkForReview,
  importLink,
  uploadPhoto,
  uploadPhotoForReview,
} from "./api";
import { prepareOriginal, renameWithExtension } from "./photo";

export type AddStage = "preparing" | "uploading";

export const ADD_STAGE_LABELS: Record<AddStage, string> = {
  preparing: "Preparing the photo",
  uploading: "Uploading and tagging",
};

export interface AddResult {
  draft: ItemDraft;
}

export interface PipelineDeps {
  prepare: (file: Blob) => Promise<Blob>;
  uploadPhoto: typeof uploadPhoto;
  uploadPhotoForReview: typeof uploadPhotoForReview;
  importLink: typeof importLink;
  finishLink: typeof finishLink;
  finishLinkForReview: typeof finishLinkForReview;
}

export function defaultDeps(): PipelineDeps {
  return { prepare: prepareOriginal, uploadPhoto, uploadPhotoForReview, importLink, finishLink, finishLinkForReview };
}

/** The resized JPEG and the name to upload it under (mock markers in the name survive). */
async function preparedPhoto(file: File, deps: PipelineDeps) {
  const blob = await deps.prepare(file);
  return { blob, name: renameWithExtension(file.name || "photo", "jpg") };
}

/** Add one photo (also the screenshot fallback for a link, with `sourceUrl`): returns a draft to review. */
export async function addByPhoto(
  file: File,
  options: { sourceUrl?: string; onStage?: (stage: AddStage) => void; deps?: PipelineDeps } = {},
): Promise<AddResult> {
  const deps = options.deps ?? defaultDeps();
  options.onStage?.("preparing");
  const original = await preparedPhoto(file, deps);
  options.onStage?.("uploading");
  const draft = await deps.uploadPhoto({ original, sourceUrl: options.sourceUrl });
  return { draft };
}

/** Add by link, step 2 for a single link: tag the stored product image and return a draft to review. */
export async function finishLinkImport(
  step1: { originalImageKey: string },
  options: { deps?: PipelineDeps } = {},
): Promise<AddResult> {
  const deps = options.deps ?? defaultDeps();
  const draft = await deps.finishLink(step1.originalImageKey);
  return { draft };
}

/**
 * The product link from a share-target visit. Android may put the link in
 * `url`, or only inside `text` ("Look at this https://…").
 */
export function linkFromShare(params: { url?: string | null; text?: string | null }): string {
  const candidates = [params.url, params.text];
  for (const value of candidates) {
    const match = value?.match(/https?:\/\/[^\s<>"']+/i);
    if (match) return match[0];
  }
  return "";
}

// ---------------------------------------------------------------------------
// Several links pasted at once
// ---------------------------------------------------------------------------

/**
 * Most photos or links one batch takes: the daily item cap (40), so a
 * batch never queues more than a day's worth.
 */
export const MAX_BATCH_SIZE = 40;

const LINK_PATTERN = /https?:\/\/[^\s<>"'`]+/gi;
const TRAILING_PUNCTUATION = /[.,;:!?'"*>\]}]+$/;

/** Drop punctuation a sentence put after a link, keeping a ")" that closes a "(" inside it. */
function trimLink(raw: string): string {
  let link = raw;
  for (;;) {
    const before = link;
    link = link.replace(TRAILING_PUNCTUATION, "");
    if (link.endsWith(")")) {
      const opens = (link.match(/\(/g) ?? []).length;
      const closes = (link.match(/\)/g) ?? []).length;
      if (closes > opens) link = link.slice(0, -1);
    }
    if (link === before) return link;
  }
}

/**
 * Every http(s) link in pasted text (one per line, or a block of text with
 * links in it), in order, without duplicates. Two links count as the same
 * when they're the same address once parsed (case of the host, a missing
 * "/" path). At most MAX_BATCH_SIZE; `extra` says how many more there were.
 */
export function extractLinks(text: string): { links: string[]; extra: number } {
  const seen = new Set<string>();
  const links: string[] = [];
  for (const match of text.matchAll(LINK_PATTERN)) {
    const parsed = SourceUrlSchema.safeParse(trimLink(match[0]));
    if (!parsed.success) continue;
    let key: string;
    try {
      key = new URL(parsed.data).href;
    } catch {
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    links.push(parsed.data);
  }
  return { links: links.slice(0, MAX_BATCH_SIZE), extra: Math.max(0, links.length - MAX_BATCH_SIZE) };
}

// ---------------------------------------------------------------------------
// Batches: one after another, saved as "to review"
// ---------------------------------------------------------------------------

export type BatchStage = "waiting" | "preparing" | "reading" | "uploading";

export const BATCH_STAGE_LABELS: Record<BatchStage, string> = {
  waiting: "Waiting",
  preparing: "Preparing",
  reading: "Reading the page",
  uploading: "Tagging",
};

/** Where one photo or link of a batch has got to. */
export type BatchEntryState =
  | { kind: "pending"; stage: BatchStage }
  /** Saved with its suggested tags, marked "to review". */
  | { kind: "saved"; item: WardrobeItem }
  /** Tagging failed: a draft to fill in and save (not in the wardrobe yet). */
  | { kind: "draft"; draft: ItemDraft }
  /** Links only: the site couldn't be read, so it needs a screenshot. */
  | { kind: "needs_screenshot"; sourceUrl: string; message: string }
  /** This one failed (a bad file, say); the batch carried on. */
  | { kind: "failed"; error: unknown }
  /** The batch stopped before reaching this one (daily cap, AI paused, signed out). */
  | { kind: "not_added" };

/**
 * Errors that stop the whole batch: the rest would fail the same way. A
 * bad photo or an unreadable page only affects its own entry.
 */
export function stopsBatch(error: unknown): boolean {
  return (
    error instanceof ApiClientError &&
    (error.code === "daily_cap_reached" || error.code === "ai_paused" || error.code === "unauthorized" || error.code === "network")
  );
}

export interface BatchOutcome {
  states: BatchEntryState[];
  /** The error that stopped the batch early, or null if every entry was tried. */
  stoppedBy: unknown;
}

function fromBatchResponse(response: BatchAddResponse): BatchEntryState {
  return response.status === "saved" ? { kind: "saved", item: response.item } : { kind: "draft", draft: response.draft };
}

/** Run `processOne` for each input in turn, reporting every change; stop early on a stopsBatch error. */
async function runBatch<T>(
  inputs: readonly T[],
  processOne: (input: T, onStage: (stage: BatchStage) => void) => Promise<BatchEntryState>,
  onChange: (index: number, state: BatchEntryState) => void,
): Promise<BatchOutcome> {
  const states: BatchEntryState[] = inputs.map(() => ({ kind: "pending", stage: "waiting" }));
  const set = (index: number, state: BatchEntryState) => {
    states[index] = state;
    onChange(index, state);
  };
  for (let index = 0; index < inputs.length; index++) {
    try {
      set(index, await processOne(inputs[index]!, (stage) => set(index, { kind: "pending", stage })));
    } catch (error) {
      if (stopsBatch(error)) {
        // This one and the rest weren't added; the summary says why once.
        for (let rest = index; rest < inputs.length; rest++) set(rest, { kind: "not_added" });
        return { states, stoppedBy: error };
      }
      set(index, { kind: "failed", error });
    }
  }
  return { states, stoppedBy: null };
}

/** Several photos: each resized and uploaded in turn with saveForReview. */
export function addPhotosForReview(
  files: readonly File[],
  onChange: (index: number, state: BatchEntryState) => void,
  deps: PipelineDeps = defaultDeps(),
): Promise<BatchOutcome> {
  return runBatch(
    files,
    async (file, onStage) => {
      onStage("preparing");
      const original = await preparedPhoto(file, deps);
      onStage("uploading");
      return fromBatchResponse(await deps.uploadPhotoForReview({ original }));
    },
    onChange,
  );
}

/** One screenshot for a link of a batch that needed the fallback; saved as "to review" like the rest. */
export async function addScreenshotForReview(file: File, sourceUrl: string, deps: PipelineDeps = defaultDeps()): Promise<BatchEntryState> {
  const original = await preparedPhoto(file, deps);
  return fromBatchResponse(await deps.uploadPhotoForReview({ original, sourceUrl }));
}

/** Several links: both steps for each in turn, with saveForReview. Unreadable sites are left for a screenshot. */
export function addLinksForReview(
  links: readonly string[],
  onChange: (index: number, state: BatchEntryState) => void,
  deps: PipelineDeps = defaultDeps(),
): Promise<BatchOutcome> {
  return runBatch(
    links,
    async (link, onStage) => {
      onStage("reading");
      const imported: LinkImportResponse = await deps.importLink(link);
      if (imported.status === "needs_screenshot") {
        return { kind: "needs_screenshot", sourceUrl: imported.sourceUrl, message: imported.message };
      }
      onStage("uploading");
      return fromBatchResponse(await deps.finishLinkForReview(imported.originalImageKey));
    },
    onChange,
  );
}

/** Counts for the end-of-batch summary. */
export function summariseBatch(states: readonly BatchEntryState[]) {
  const count = (kind: BatchEntryState["kind"]) => states.filter((s) => s.kind === kind).length;
  return {
    total: states.length,
    saved: count("saved"),
    drafts: count("draft"),
    needsScreenshot: count("needs_screenshot"),
    failed: count("failed"),
    notAdded: count("not_added"),
    finished: states.filter((s) => s.kind !== "pending").length,
  };
}
