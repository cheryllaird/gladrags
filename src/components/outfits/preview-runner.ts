/**
 * Asks for outfit pictures one after another (docs/CONTRACTS.md, section 12:
 * "The client calls it once per outfit in a new set, one after another").
 *
 * - `enqueue(outfits)` adds the outfits that still need a picture and that
 *   this runner hasn't seen, so a refinement or swap asks for its new
 *   outfits only, and going back to an earlier set asks for nothing.
 * - While a preview is `pending` (or `refreshing`), the same POST is sent
 *   again every PREVIEW_POLL_INTERVAL_MS, up to `maxPolls` times.
 * - `refresh(id)` is "Update preview": `?refresh=true`, ahead of the queue.
 * - A `bad_request` on `modelPresetId` (no model picked) pauses the queue
 *   until `resume()`; so does a settings check that finds none picked.
 * - The daily cap or the pause ends the queue: the rest would be refused too.
 * - `stop()` (the screen going away) drops whatever is in flight; `start()`
 *   picks the queue up again (React's development double mount).
 *
 * Plain TypeScript with injected dependencies, so it's unit-tested without React.
 */
import { PREVIEW_NEEDS_PRESET_ISSUE_PATH, PREVIEW_POLL_INTERVAL_MS, type Outfit } from "@/contracts";
import type { ApiFailure, ApiResult } from "./api";
import { problemForError, previewNeedsRequest, type PreviewActivity, type PreviewProblem } from "./preview-view";

/** Polls of a pending preview before giving up for now: about 3 minutes, past the 150 s takeover. */
export const PREVIEW_MAX_POLLS = 60;

export interface PreviewRunnerDeps {
  requestPreview(outfitId: string, options: { refresh: boolean }): Promise<ApiResult<{ outfit: Outfit }>>;
  /** Whether a model preset is picked. "unknown" (e.g. offline) carries on and lets the preview route say. */
  checkPreset?(): Promise<"picked" | "missing" | "unknown">;
  /** The outfit as the server now has it. Can be replaced later with setOnOutfit. */
  onOutfit?(outfit: Outfit): void;
  onChange(state: PreviewRunnerState): void;
  pollIntervalMs?: number;
  maxPolls?: number;
  /** Waits `ms`, or resolves early when the signal aborts. */
  sleep?(ms: number, signal: AbortSignal): Promise<void>;
}

export interface PreviewRunnerState {
  /** Outfits queued or being asked for, in order (the first is in flight while `busy`). */
  queuedIds: readonly string[];
  problems: Readonly<Record<string, PreviewProblem>>;
  needsPreset: boolean;
}

export const EMPTY_RUNNER_STATE: PreviewRunnerState = { queuedIds: [], problems: {}, needsPreset: false };

interface Entry {
  id: string;
  refresh: boolean;
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

export function isNeedsPresetError(error: ApiFailure): boolean {
  return error.code === "bad_request" && (error.issues ?? []).some((issue) => issue.path === PREVIEW_NEEDS_PRESET_ISSUE_PATH);
}

type Outcome = "done" | "needs_preset" | "halt" | "stopped";

export class PreviewRunner {
  private readonly deps: PreviewRunnerDeps;
  private queue: Entry[] = [];
  /** The entry being asked for right now, if any. */
  private active: Entry | null = null;
  private readonly seen = new Set<string>();
  private problems: Record<string, PreviewProblem> = {};
  private needsPreset = false;
  private presetChecked = false;
  /** Bumped by start() and stop(); a loop from an older generation stops. */
  private generation = 0;
  private runningGeneration = -1;
  private abort = new AbortController();
  private started = false;

  private onOutfit: (outfit: Outfit) => void;

  constructor(deps: PreviewRunnerDeps) {
    this.deps = deps;
    this.onOutfit = deps.onOutfit ?? (() => {});
  }

  /** Where each outfit goes as the server returns it (the screen's latest callback). */
  setOnOutfit(onOutfit: (outfit: Outfit) => void): void {
    this.onOutfit = onOutfit;
  }

  state(): PreviewRunnerState {
    const ids = [...(this.active ? [this.active.id] : []), ...this.queue.map((e) => e.id)];
    return { queuedIds: ids, problems: { ...this.problems }, needsPreset: this.needsPreset };
  }

  /** What the runner is doing with one outfit, for previewView. */
  activityFor(state: PreviewRunnerState, outfitId: string): PreviewActivity {
    const inProgress = state.queuedIds.includes(outfitId);
    return {
      inProgress: inProgress && !state.needsPreset,
      awaitingPreset: inProgress && state.needsPreset,
      problem: state.problems[outfitId] ?? null,
    };
  }

  start(): void {
    this.generation++;
    this.started = true;
    this.abort = new AbortController();
    void this.pump();
  }

  stop(): void {
    this.generation++;
    this.started = false;
    this.abort.abort();
    // Whatever was in flight goes back to the front, for a later start().
    if (this.active) {
      this.queue.unshift(this.active);
      this.active = null;
    }
  }

  /** Queue the outfits that still need a picture and haven't been queued before. */
  enqueue(outfits: readonly Outfit[]): void {
    let added = false;
    for (const outfit of outfits) {
      if (this.seen.has(outfit.id)) continue;
      this.seen.add(outfit.id);
      if (!previewNeedsRequest(outfit)) continue;
      this.queue.push({ id: outfit.id, refresh: outfit.preview.refreshing });
      added = true;
    }
    if (added) {
      this.emit();
      void this.pump();
    }
  }

  /** "Update preview": ask for a new picture of an outdated one, next in line. */
  refresh(outfitId: string): void {
    this.seen.add(outfitId);
    if (this.active?.id === outfitId) return;
    this.queue = this.queue.filter((e) => e.id !== outfitId);
    this.queue.unshift({ id: outfitId, refresh: true });
    delete this.problems[outfitId];
    this.emit();
    void this.pump();
  }

  /** A model preset has been saved: carry on. */
  resume(): void {
    this.needsPreset = false;
    this.presetChecked = true;
    this.emit();
    void this.pump();
  }

  private emit() {
    this.deps.onChange(this.state());
  }

  private async pump(): Promise<void> {
    const generation = this.generation;
    if (!this.started || this.needsPreset || this.runningGeneration === generation) return;
    if (this.queue.length === 0) return;
    this.runningGeneration = generation;
    try {
      if (!this.presetChecked && this.deps.checkPreset) {
        this.presetChecked = true;
        const preset = await this.deps.checkPreset();
        if (generation !== this.generation) return;
        if (preset === "missing") {
          this.needsPreset = true;
          this.emit();
          return;
        }
      }
      while (this.queue.length > 0 && generation === this.generation && !this.needsPreset) {
        const entry = this.queue.shift()!;
        this.active = entry;
        this.emit();
        const outcome = await this.process(entry, generation);
        if (outcome === "stopped") return; // stop() has put it back already.
        this.active = null;
        if (outcome === "needs_preset") {
          this.queue.unshift(entry);
          this.needsPreset = true;
        } else if (outcome === "halt") {
          // Today's cap or the pause: the rest would be refused the same way.
          const problem = this.problems[entry.id]!;
          for (const rest of this.queue) this.problems[rest.id] = problem;
          this.queue = [];
        }
        this.emit();
      }
    } finally {
      if (this.runningGeneration === generation) this.runningGeneration = -1;
    }
    // Something may have been queued while the last request was finishing.
    if (generation === this.generation && this.queue.length > 0 && !this.needsPreset) void this.pump();
  }

  private async process(entry: Entry, generation: number): Promise<Outcome> {
    const interval = this.deps.pollIntervalMs ?? PREVIEW_POLL_INTERVAL_MS;
    const maxPolls = this.deps.maxPolls ?? PREVIEW_MAX_POLLS;
    const sleep = this.deps.sleep ?? defaultSleep;
    let refresh = entry.refresh;
    for (let polls = 0; ; polls++) {
      const result = await this.deps.requestPreview(entry.id, { refresh });
      if (generation !== this.generation) return "stopped";
      if (!result.ok) {
        if (isNeedsPresetError(result.error)) return "needs_preset";
        const problem = problemForError(result.error);
        this.problems[entry.id] = problem;
        return problem.kind === "daily_cap" || problem.kind === "paused" ? "halt" : "done";
      }
      const outfit = result.data.outfit;
      delete this.problems[entry.id];
      this.onOutfit(outfit);
      if (outfit.preview.status !== "pending" && !outfit.preview.refreshing) return "done";
      if (polls >= maxPolls) {
        this.problems[entry.id] = { kind: "slow" };
        return "done";
      }
      refresh = outfit.preview.refreshing;
      await sleep(interval, this.abort.signal);
      if (generation !== this.generation) return "stopped";
    }
  }
}
