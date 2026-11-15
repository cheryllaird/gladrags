import { describe, expect, it, vi } from "vitest";
import { NO_PREVIEW, type Outfit, type OutfitPreview } from "@/contracts";
import type { ApiFailure, ApiResult } from "./api";
import {
  PreviewRunner,
  RESULTS_POLICY,
  SAVED_POLICY,
  canAskForPicture,
  isNeedsPresetError,
  type PreviewRunnerDeps,
  type PreviewRunnerState,
} from "./preview-runner";
import { previewView } from "./preview-view";

const READY: OutfitPreview = {
  ...NO_PREVIEW,
  status: "ready",
  imageUrl: "/mock/previews/preview.svg",
  presetId: "women_average_medium",
};
const PENDING: OutfitPreview = { ...NO_PREVIEW, status: "pending", presetId: "women_average_medium" };

function outfit(n: number, preview: OutfitPreview = NO_PREVIEW): Outfit {
  return {
    id: `2b000000-0000-4000-8000-00000000000${n}`,
    request: { style: { kind: "preset", presetId: "casual" }, guidance: null, anchorItemId: null, includeShopItems: false },
    name: `Outfit ${n}`,
    reason: "Because",
    itemIds: [],
    items: [],
    gaps: [],
    status: "suggested",
    parentOutfitId: null,
    createdAt: "2026-11-14T10:00:00.000Z",
    preview,
  };
}

const NEEDS_PRESET: ApiFailure = {
  code: "bad_request",
  message: "Pick a model first.",
  issues: [{ path: "modelPresetId", message: "No model preset picked yet" }],
};
const CAP: ApiFailure = {
  code: "daily_cap_reached",
  message: "Cap",
  cap: { kind: "outfit_previews_per_day", limit: 12, resetsAt: "2026-11-15T00:00:00.000Z" },
};
const FAILED: ApiFailure = { code: "ai_failed", message: "No picture" };

/** A deferred answer per call, so tests decide when each request finishes. */
function harness(options: Partial<PreviewRunnerDeps> = {}) {
  const calls: { id: string; refresh: boolean; resolve: (r: ApiResult<{ outfit: Outfit }>) => void }[] = [];
  const outfits: Outfit[] = [];
  const states: PreviewRunnerState[] = [];
  const runner = new PreviewRunner({
    requestPreview: (id, { refresh }) =>
      new Promise((resolve) => {
        calls.push({ id, refresh, resolve });
      }),
    onOutfit: (o) => outfits.push(o),
    onChange: (s) => states.push(s),
    sleep: () => Promise.resolve(),
    ...options,
  });
  const last = () => states.at(-1)!;
  return { runner, calls, outfits, last };
}

/** Let pending promise callbacks run. */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("PreviewRunner", () => {
  it("asks for each new outfit's picture one after another, never two at once", async () => {
    const { runner, calls, outfits, last } = harness();
    runner.start();
    const [a, b, c] = [outfit(1), outfit(2), outfit(3)];
    runner.enqueue([a, b, c]);
    await flush();
    expect(calls.map((c) => c.id)).toEqual([a.id]);
    expect(last().queuedIds).toEqual([a.id, b.id, c.id]);

    calls[0]!.resolve({ ok: true, data: { outfit: { ...a, preview: READY } } });
    await flush();
    expect(calls.map((c) => c.id)).toEqual([a.id, b.id]);
    expect(outfits.map((o) => o.preview.status)).toEqual(["ready"]);

    calls[1]!.resolve({ ok: true, data: { outfit: { ...b, preview: READY } } });
    await flush();
    calls[2]!.resolve({ ok: true, data: { outfit: { ...c, preview: READY } } });
    await flush();
    expect(calls).toHaveLength(3);
    expect(calls.every((c) => !c.refresh)).toBe(true);
    expect(last().queuedIds).toEqual([]);
  });

  it("asks only for outfits it hasn't seen, and only those that need a picture", async () => {
    const { runner, calls } = harness();
    runner.start();
    const first = outfit(1);
    runner.enqueue([first, outfit(2, READY)]);
    await flush();
    calls[0]!.resolve({ ok: true, data: { outfit: { ...first, preview: READY } } });
    await flush();
    // A refinement: the earlier outfit is shown again alongside a new one.
    const fresh = outfit(3);
    runner.enqueue([first, fresh]);
    await flush();
    expect(calls.map((c) => c.id)).toEqual([first.id, fresh.id]);
  });

  it("polls a pending preview with the same POST until it's ready", async () => {
    const sleep = vi.fn(() => Promise.resolve());
    const { runner, calls, outfits } = harness({ sleep, pollIntervalMs: 3000 });
    runner.start();
    const a = outfit(1);
    runner.enqueue([a]);
    await flush();
    calls[0]!.resolve({ ok: true, data: { outfit: { ...a, preview: PENDING } } });
    await flush();
    expect(sleep).toHaveBeenCalledWith(3000, expect.any(AbortSignal));
    expect(calls).toHaveLength(2);
    calls[1]!.resolve({ ok: true, data: { outfit: { ...a, preview: READY } } });
    await flush();
    expect(outfits.map((o) => o.preview.status)).toEqual(["pending", "ready"]);
    expect(calls).toHaveLength(2);
  });

  it("gives up polling after the maximum and says it's slow", async () => {
    const { runner, calls, last } = harness({ maxPolls: 2 });
    runner.start();
    const a = outfit(1);
    runner.enqueue([a]);
    for (let i = 0; i < 2; i++) {
      await flush();
      calls[i]!.resolve({ ok: true, data: { outfit: { ...a, preview: PENDING } } });
    }
    await flush();
    // Exactly maxPolls POSTs in all.
    expect(calls).toHaveLength(2);
    expect(last().problems[a.id]).toEqual({ kind: "slow" });
    expect(last().queuedIds).toEqual([]);
  });

  it("stops when the screen goes away: no more requests, answers dropped", async () => {
    const { runner, calls, outfits } = harness();
    runner.start();
    const [a, b] = [outfit(1), outfit(2)];
    runner.enqueue([a, b]);
    await flush();
    runner.stop();
    calls[0]!.resolve({ ok: true, data: { outfit: { ...a, preview: READY } } });
    await flush();
    expect(outfits).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("picks up again after a stop and start (React's development double mount)", async () => {
    const { runner, calls } = harness();
    runner.start();
    const a = outfit(1);
    runner.enqueue([a]);
    await flush();
    runner.stop();
    runner.start();
    await flush();
    expect(calls.map((c) => c.id)).toEqual([a.id, a.id]);
  });

  it("refresh is 'Update preview': ?refresh=true, ahead of the queue, and polled with refresh while refreshing", async () => {
    const { runner, calls } = harness();
    runner.start();
    const outdated = outfit(1, { ...READY, outdated: true });
    const [b, c] = [outfit(2), outfit(3)];
    runner.enqueue([outdated, b, c]);
    await flush();
    runner.refresh(outdated.id);
    calls[0]!.resolve({ ok: true, data: { outfit: { ...b, preview: READY } } });
    await flush();
    expect(calls[1]).toMatchObject({ id: outdated.id, refresh: true });
    calls[1]!.resolve({ ok: true, data: { outfit: { ...outdated, preview: { ...outdated.preview, refreshing: true } } } });
    await flush();
    expect(calls[2]).toMatchObject({ id: outdated.id, refresh: true });
    calls[2]!.resolve({ ok: true, data: { outfit: { ...outdated, preview: READY } } });
    await flush();
    expect(calls[3]).toMatchObject({ id: c.id, refresh: false });
  });

  it("pauses for 'Pick your model' and carries on with the same outfit after resume", async () => {
    const { runner, calls, last } = harness();
    runner.start();
    const [a, b] = [outfit(1), outfit(2)];
    runner.enqueue([a, b]);
    await flush();
    calls[0]!.resolve({ ok: false, error: NEEDS_PRESET });
    await flush();
    expect(last().needsPreset).toBe(true);
    expect(runner.activityFor(last(), a.id)).toEqual({ inProgress: false, awaitingPreset: true, problem: null });
    expect(calls).toHaveLength(1);

    runner.resume();
    await flush();
    expect(last().needsPreset).toBe(false);
    expect(calls.map((c) => c.id)).toEqual([a.id, a.id]);
  });

  it("asks for the model first when the settings say none is picked", async () => {
    const checkPreset = vi.fn(async () => "missing" as const);
    const { runner, calls, last } = harness({ checkPreset });
    runner.start();
    runner.enqueue([outfit(1)]);
    await flush();
    expect(last().needsPreset).toBe(true);
    expect(calls).toHaveLength(0);
    runner.resume();
    await flush();
    expect(calls).toHaveLength(1);
    expect(checkPreset).toHaveBeenCalledTimes(1);
  });

  it("carries on when the settings check can't tell", async () => {
    const { runner, calls } = harness({ checkPreset: async () => "unknown" });
    runner.start();
    runner.enqueue([outfit(1)]);
    await flush();
    expect(calls).toHaveLength(1);
  });

  it("a failure keeps the collage for that outfit and moves on to the next", async () => {
    const { runner, calls, last } = harness();
    runner.start();
    const [a, b] = [outfit(1), outfit(2)];
    runner.enqueue([a, b]);
    await flush();
    calls[0]!.resolve({ ok: false, error: FAILED });
    await flush();
    expect(last().problems[a.id]).toEqual({ kind: "failed", error: FAILED });
    expect(calls.map((c) => c.id)).toEqual([a.id, b.id]);
  });

  it("the daily cap ends the queue: the rest get the same note without asking", async () => {
    const { runner, calls, last } = harness();
    runner.start();
    const [a, b, c] = [outfit(1), outfit(2), outfit(3)];
    runner.enqueue([a, b, c]);
    await flush();
    calls[0]!.resolve({ ok: false, error: CAP });
    await flush();
    expect(calls).toHaveLength(1);
    for (const o of [a, b, c]) expect(last().problems[o.id]).toEqual({ kind: "daily_cap", error: CAP });
    expect(last().queuedIds).toEqual([]);
  });

  it("recognises the no-preset bad_request by its issue path only", () => {
    expect(isNeedsPresetError(NEEDS_PRESET)).toBe(true);
    expect(isNeedsPresetError({ code: "bad_request", message: "x", issues: [{ path: "refresh", message: "x" }] })).toBe(false);
    expect(isNeedsPresetError({ code: "not_found", message: "x" })).toBe(false);
  });

  it("results also ask again for a failure from a passing reason, not a final one", () => {
    const failed = (failureReason: "ai_failed" | "internal" | "blocked" | "invalid_image") => ({
      preview: { ...NO_PREVIEW, status: "failed" as const, failureReason, presetId: "women_average_medium" as const },
    });
    expect(RESULTS_POLICY(failed("ai_failed"))).toBe(true);
    expect(RESULTS_POLICY(failed("internal"))).toBe(true);
    expect(RESULTS_POLICY(failed("blocked"))).toBe(false);
    expect(RESULTS_POLICY(failed("invalid_image"))).toBe(false);
    expect(RESULTS_POLICY({ preview: READY })).toBe(false);
  });

  it("the saved list only picks up pictures already being made; the rest wait for See it worn", async () => {
    const { runner, calls } = harness();
    runner.start();
    const skipped = outfit(2, { ...NO_PREVIEW, status: "skipped", failureReason: "daily_cap_reached" });
    const retryable = outfit(3, { ...NO_PREVIEW, status: "failed", failureReason: "ai_failed" });
    const none = outfit(1);
    const pending = outfit(4, PENDING);
    runner.enqueue([none, skipped, retryable, pending, outfit(5, READY)], SAVED_POLICY);
    await flush();
    expect(calls.map((c) => c.id)).toEqual([pending.id]);
    for (const o of [none, skipped, retryable]) expect(canAskForPicture(o)).toBe(true);
    expect(canAskForPicture(outfit(6, READY))).toBe(false);
    expect(canAskForPicture(outfit(7, { ...NO_PREVIEW, status: "failed", failureReason: "blocked" }))).toBe(false);

    calls[0]!.resolve({ ok: true, data: { outfit: { ...pending, preview: READY } } });
    await flush();
    // "See it worn" on one that was seen but not asked for.
    runner.ask(none);
    await flush();
    expect(calls.map((c) => c.id)).toEqual([pending.id, none.id]);
  });

  it("remembers the cap for its whole life: later outfits get the note without asking", async () => {
    const { runner, calls, last } = harness();
    runner.start();
    const a = outfit(1);
    runner.enqueue([a]);
    await flush();
    calls[0]!.resolve({ ok: false, error: CAP });
    await flush();
    const [later, seeItWorn] = [outfit(2), outfit(3)];
    runner.enqueue([later]);
    runner.ask(seeItWorn);
    runner.refresh(outfit(4, { ...READY, outdated: true }).id);
    await flush();
    expect(calls).toHaveLength(1);
    expect(last().problems[later.id]).toEqual({ kind: "daily_cap", error: CAP });
    expect(last().problems[seeItWorn.id]).toEqual({ kind: "daily_cap", error: CAP });
    expect(last().queuedIds).toEqual([]);
  });

  it("a refresh poll that errors ends Updating…: the old picture stays with Update preview and a short note", async () => {
    const { runner, calls, last } = harness();
    runner.start();
    const o = outfit(1, { ...READY, outdated: true });
    runner.refresh(o.id);
    await flush();
    const refreshing = { ...READY, outdated: true, refreshing: true };
    calls[0]!.resolve({ ok: true, data: { outfit: { ...o, preview: refreshing } } });
    await flush();
    calls[1]!.resolve({ ok: false, error: FAILED });
    await flush();
    const view = previewView(refreshing, runner.activityFor(last(), o.id));
    expect(view).toMatchObject({
      kind: "image",
      refreshing: false,
      outdated: true,
      note: { title: "Couldn't update the picture", message: "Try again later. The earlier picture stays for now." },
    });
  });

  it("a sheet closed without a saved model leaves the queue waiting, and the next enqueue asks again", async () => {
    const { runner, calls, last } = harness();
    runner.start();
    const a = outfit(1);
    runner.enqueue([a]);
    await flush();
    calls[0]!.resolve({ ok: false, error: NEEDS_PRESET });
    await flush();
    runner.dismissPreset();
    expect(last()).toMatchObject({ needsPreset: false, presetDismissed: true });
    expect(runner.activityFor(last(), a.id)).toMatchObject({ awaitingPreset: true, inProgress: false });
    await flush();
    expect(calls).toHaveLength(1);

    runner.enqueue([outfit(2)]);
    expect(last()).toMatchObject({ needsPreset: true, presetDismissed: false });
    runner.resume();
    await flush();
    expect(calls.map((c) => c.id)).toEqual([a.id, a.id]);
  });

  it("reports progress through a run for the screen's live line", async () => {
    const { runner, calls, last } = harness();
    runner.start();
    const [a, b] = [outfit(1), outfit(2)];
    runner.enqueue([a, b]);
    await flush();
    expect(last()).toMatchObject({ active: { id: a.id, refresh: false }, progress: { done: 0, total: 2 } });
    calls[0]!.resolve({ ok: true, data: { outfit: { ...a, preview: READY } } });
    await flush();
    expect(last()).toMatchObject({ active: { id: b.id }, progress: { done: 1, total: 2 } });
    calls[1]!.resolve({ ok: true, data: { outfit: { ...b, preview: READY } } });
    await flush();
    expect(last()).toMatchObject({ active: null, progress: { done: 0, total: 0 } });
  });
});
