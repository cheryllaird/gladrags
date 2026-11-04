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
 * - A collage that goes away (unmounts) before its turn has its jobs
 *   skipped, unless another collage still wants the same item.
 * - Removal that takes longer than REMOVAL_TIMEOUT_MS counts as a failure,
 *   so a hung model can't stop every later cut-out.
 * - Only the latest MAX_KEPT_RESULTS cut-outs are kept in memory; older
 *   ones are freed (URL.revokeObjectURL). A collage drawn later then uses
 *   the original, or the server's cut-out once the outfit is fetched again.
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
  /** Free a URL made by toUrl (URL.revokeObjectURL in the browser). Optional: nothing to free in tests. */
  revokeUrl?(url: string): void;
}

/** A hung remover counts as failed after this long. */
export const REMOVAL_TIMEOUT_MS = 30_000;
/** Cut-outs kept in memory for this session; older ones are freed. */
export const MAX_KEPT_RESULTS = 20;

/** What a collage needs to know about an item to ask for its cut-out. */
export type CutoutCandidate = Pick<WardrobeItem, "id" | "originalUrl" | "cutoutUrl" | "needsPhoto">;

export interface CutoutResult {
  /** Where to draw the cut-out from, or null: keep the original. */
  url: string | null;
  /** True if the server stored it, so other devices and later visits get it too. */
  uploaded: boolean;
}

const NO_CUTOUT: CutoutResult = { url: null, uploaded: false };

interface Job {
  promise: Promise<CutoutResult>;
  /** One per request; null for a request that can't be called off. */
  signals: (AbortSignal | null)[];
}

/** Reject if `promise` takes longer than `ms`. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
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
  private readonly jobs = new Map<string, Job>();
  /** Finished results, oldest first (Map keeps insertion order). */
  private readonly settled = new Map<string, CutoutResult>();
  /** Items whose result was freed: done this session, so not cut out again. */
  private readonly freed = new Set<string>();
  /** The end of the line: each job starts when the one before it has finished. */
  private tail: Promise<unknown> = Promise.resolve();
  private deps: CutoutDeps | null = null;
  private readonly removalTimeoutMs: number;
  private readonly maxKept: number;

  /** `makeDeps` runs on first use, so nothing loads until a collage needs a cut-out. */
  constructor(
    private readonly makeDeps: () => CutoutDeps,
    options: { removalTimeoutMs?: number; maxKept?: number } = {},
  ) {
    this.removalTimeoutMs = options.removalTimeoutMs ?? REMOVAL_TIMEOUT_MS;
    this.maxKept = options.maxKept ?? MAX_KEPT_RESULTS;
  }

  /** The finished result for this item, if there is one yet. */
  peek(itemId: string): CutoutResult | undefined {
    return this.settled.get(itemId);
  }

  /**
   * Cut the item out (once per session), queued behind any other cut-out
   * in progress. Resolves with where to draw it from, or `url: null`.
   * If `signal` aborts before the job's turn (its collage went away), and
   * no other request for the item is still waiting, the job is skipped and
   * a later request can queue it again.
   */
  request(item: CutoutCandidate, signal?: AbortSignal): Promise<CutoutResult> {
    if (this.freed.has(item.id)) return Promise.resolve(NO_CUTOUT);
    const existing = this.jobs.get(item.id);
    if (existing) {
      existing.signals.push(signal ?? null);
      return existing.promise;
    }

    const job: Job = { promise: Promise.resolve(NO_CUTOUT), signals: [signal ?? null] };
    job.promise = this.tail.then(() => this.run(item, job));
    this.tail = job.promise;
    this.jobs.set(item.id, job);
    return job.promise;
  }

  private async run(item: CutoutCandidate, job: Job): Promise<CutoutResult> {
    if (job.signals.every((s) => s?.aborted)) {
      this.jobs.delete(item.id);
      return NO_CUTOUT;
    }
    const result = await this.cutOut(item);
    // cutOut drops the job when a later request should try again.
    if (this.jobs.get(item.id) === job) this.keep(item.id, result);
    return result;
  }

  /** Record a result, freeing the oldest ones beyond maxKept. */
  private keep(itemId: string, result: CutoutResult) {
    this.settled.set(itemId, result);
    while (this.settled.size > this.maxKept) {
      const [oldestId, oldest] = this.settled.entries().next().value!;
      this.settled.delete(oldestId);
      this.jobs.delete(oldestId);
      this.freed.add(oldestId);
      if (oldest.url) {
        try {
          this.deps?.revokeUrl?.(oldest.url);
        } catch {
          // Nothing to free.
        }
      }
    }
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
      this.jobs.delete(item.id);
      return NO_CUTOUT;
    }

    let cutout: Blob | null;
    try {
      cutout = await deps.fitCutout(await withTimeout(deps.removeBackground(original), this.removalTimeoutMs));
    } catch {
      cutout = null;
    }
    // Removal failed or hung: the collage keeps the original, and this
    // session doesn't try again (it would most likely fail the same way).
    if (!cutout) return NO_CUTOUT;

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
