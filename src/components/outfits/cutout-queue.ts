/**
 * Cut-outs at collage time (spec: "Collage preview"; CONTRACTS.md section 5,
 * "Cut-out for an existing item"). The first time a collage needs an item
 * that has no cut-out, the phone cuts it out of the original with the
 * in-browser background remover and uploads it with
 * PUT /api/items/[id]/cutout, so it's reused from then on.
 *
 * The rules, all handled here so the collage component stays simple:
 * - One item at a time. The model is big and phones are short on memory, so
 *   cut-outs never run side by side. The remover itself is one shared
 *   instance, so the model loads once.
 * - Each item at most once per session: every collage that shows the same
 *   item gets the same result, and a failure isn't retried over and over.
 * - Never throws. If anything fails, the result is null and the collage
 *   keeps the original.
 *
 * Dependencies are passed in, so the queue is unit-tested without a browser.
 */
import type { WardrobeItem } from "@/contracts";

export interface CutoutDeps {
  /** Download the item's original image. */
  fetchOriginal(url: string): Promise<Blob>;
  /** The in-browser background remover. Rejects when removal fails. */
  removeBackground(image: Blob): Promise<Blob>;
  /** Shrink the cut-out to the upload limits, or null if it can't be made to fit. */
  fitCutout(cutout: Blob): Promise<Blob | null>;
  /** PUT /api/items/[id]/cutout. Resolves true if the server kept it. */
  upload(itemId: string, cutout: Blob): Promise<boolean>;
  /** A URL the collage can draw from (URL.createObjectURL in the browser). */
  toUrl(cutout: Blob): string;
}

/** What a collage needs to know about an item to ask for its cut-out. */
export type CutoutCandidate = Pick<WardrobeItem, "id" | "originalUrl" | "cutoutUrl" | "needsPhoto">;

export interface CutoutResult {
  /** Where to draw the cut-out from, or null: keep the original. */
  url: string | null;
  /** True if the server stored it, so other devices and later visits get it too. */
  uploaded: boolean;
}

/**
 * True if a collage should try to cut this item out: it has no cut-out yet,
 * and its original is a real picture (not the placeholder of an emailed
 * item that came without one).
 */
export function needsCutout(item: CutoutCandidate): boolean {
  return item.cutoutUrl === null && !item.needsPhoto;
}

export class CutoutQueue {
  private readonly results = new Map<string, Promise<CutoutResult>>();
  private readonly settled = new Map<string, CutoutResult>();
  /** The end of the line: each job starts when the one before it has finished. */
  private tail: Promise<unknown> = Promise.resolve();
  private deps: CutoutDeps | null = null;

  /** `makeDeps` runs on first use, so nothing loads until a collage needs a cut-out. */
  constructor(private readonly makeDeps: () => CutoutDeps) {}

  /** The finished result for this item, if there is one yet. */
  peek(itemId: string): CutoutResult | undefined {
    return this.settled.get(itemId);
  }

  /**
   * Cut the item out (once per session), queued behind any other cut-out
   * in progress. Resolves with where to draw it from, or `url: null`.
   */
  request(item: CutoutCandidate): Promise<CutoutResult> {
    const existing = this.results.get(item.id);
    if (existing) return existing;

    const job = this.tail.then(() => this.cutOut(item));
    this.tail = job;
    this.results.set(item.id, job);
    void job.then((result) => {
      // Not if the job gave up so that a later request can try again.
      if (this.results.get(item.id) === job) this.settled.set(item.id, result);
    });
    return job;
  }

  private async cutOut(item: CutoutCandidate): Promise<CutoutResult> {
    let deps: CutoutDeps;
    let original: Blob;
    try {
      deps = this.deps ??= this.makeDeps();
      original = await deps.fetchOriginal(item.originalUrl);
    } catch {
      // Couldn't download the original (offline, or its signed URL
      // expired): let a later collage with a fresh URL try again.
      this.results.delete(item.id);
      return { url: null, uploaded: false };
    }

    let cutout: Blob | null;
    try {
      cutout = await deps.fitCutout(await deps.removeBackground(original));
    } catch {
      cutout = null;
    }
    // Removal failed: the collage keeps the original, and this session
    // doesn't try again (it would most likely fail the same way).
    if (!cutout) return { url: null, uploaded: false };

    let uploaded = false;
    try {
      uploaded = await deps.upload(item.id, cutout);
    } catch {
      uploaded = false;
    }
    // Draw the local copy either way: it's ready now, and a failed upload
    // only means the next session cuts it out again.
    try {
      return { url: deps.toUrl(cutout), uploaded };
    } catch {
      return { url: null, uploaded };
    }
  }
}
