// QA (round 2, P3): adversarial tests for the preview runner and the view
// logic it feeds. Each test plays a sequence the screen can produce:
// many outfits, refreshes and enqueues mid-flight, leaving mid-generation,
// stuck previews, and the cap, pause and no-preset refusals.
// Tests marked `it.fails` pin a known source bug (see the comment on each);
// they flip to failing, and should become plain `it`, once it's fixed.
import { afterEach, describe, expect, it, vi } from "vitest";
import { NO_PREVIEW, type Outfit, type OutfitPreview } from "@/contracts";
import type { ApiFailure, ApiResult } from "./api";
import {
  PreviewRunner,
  type PreviewRunnerDeps,
  type PreviewRunnerState,
} from "./preview-runner";
import { previewView, suggestedLabels } from "./preview-view";

const PRESET = "women_average_medium" as const;
const READY: OutfitPreview = {
  ...NO_PREVIEW,
  status: "ready",
  imageUrl: "https://x.supabase.co/sign/a.webp",
  presetId: PRESET,
};
const PENDING: OutfitPreview = {
  ...NO_PREVIEW,
  status: "pending",
  presetId: PRESET,
};
const OUTDATED: OutfitPreview = { ...READY, outdated: true };
const REFRESHING: OutfitPreview = {
  ...READY,
  outdated: true,
  refreshing: true,
};

function outfit(n: number, preview: OutfitPreview = NO_PREVIEW): Outfit {
  return {
    id: `2b000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    request: {
      style: { kind: "preset", presetId: "casual" },
      guidance: null,
      anchorItemId: null,
      includeShopItems: false,
    },
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

const CAP: ApiFailure = {
  code: "daily_cap_reached",
  message: "Cap",
  cap: {
    kind: "outfit_previews_per_day",
    limit: 12,
    resetsAt: "2026-11-15T00:00:00.000Z",
  },
};
const PAUSED: ApiFailure = {
  code: "ai_paused",
  message: "Paused",
  cap: {
    kind: "monthly_image_spend",
    limit: 200,
    resetsAt: "2026-12-01T00:00:00.000Z",
  },
};
const NEEDS_PRESET: ApiFailure = {
  code: "bad_request",
  message: "Pick a model first.",
  issues: [{ path: "modelPresetId", message: "No model preset picked yet" }],
};

type Answer = ApiResult<{ outfit: Outfit }>;
const ok = (o: Outfit): Answer => ({ ok: true, data: { outfit: o } });
const fail = (error: ApiFailure): Answer => ({ ok: false, error });

/** Requests are answered by the test; tracks how many are in flight at once. */
function harness(options: Partial<PreviewRunnerDeps> = {}) {
  const calls: {
    id: string;
    refresh: boolean;
    resolve: (r: Answer) => void;
  }[] = [];
  const outfits: Outfit[] = [];
  const states: PreviewRunnerState[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const runner = new PreviewRunner({
    requestPreview: (id, { refresh }) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise<Answer>((resolve) => {
        calls.push({
          id,
          refresh,
          resolve: (r) => {
            inFlight--;
            resolve(r);
          },
        });
      });
    },
    onOutfit: (o) => outfits.push(o),
    onChange: (s) => states.push(s),
    sleep: () => Promise.resolve(),
    ...options,
  });
  const last = () => states.at(-1)!;
  return { runner, calls, outfits, last, maxInFlight: () => maxInFlight };
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

afterEach(() => {
  vi.useRealTimers();
});

describe("many outfits: one at a time", () => {
  it("asks for 12 outfits strictly in turn, even with enqueues and refreshes arriving mid-flight", async () => {
    const h = harness();
    h.runner.start();
    const set = Array.from({ length: 12 }, (_, i) => outfit(i + 1));
    h.runner.enqueue(set.slice(0, 6));
    await flush();
    // A second batch (a refinement) and a refresh land while the first is in flight.
    h.runner.enqueue(set.slice(6));
    const outdated = outfit(99, OUTDATED);
    h.runner.refresh(outdated.id);
    await flush();
    expect(h.calls).toHaveLength(1);

    const order: string[] = [];
    while (h.calls.length > order.length) {
      const call = h.calls[order.length]!;
      order.push(call.id);
      const answered = set.find((o) => o.id === call.id) ?? outdated;
      call.resolve(ok({ ...answered, preview: READY }));
      await flush();
    }
    expect(h.maxInFlight()).toBe(1);
    // The refresh is next in line after the in-flight one, then the rest in order.
    expect(order).toEqual([
      set[0]!.id,
      outdated.id,
      ...set.slice(1).map((o) => o.id),
    ]);
    expect(new Set(order).size).toBe(order.length);
    expect(h.last().queuedIds).toEqual([]);
  });

  it("enqueueing the same set again (going Back, or a refine that repeats outfits) asks for nothing more", async () => {
    const h = harness();
    h.runner.start();
    const set = [outfit(1), outfit(2)];
    h.runner.enqueue(set);
    h.runner.enqueue(set);
    await flush();
    h.calls[0]!.resolve(ok({ ...set[0]!, preview: READY }));
    await flush();
    h.runner.enqueue(set);
    h.calls[1]!.resolve(ok({ ...set[1]!, preview: READY }));
    await flush();
    h.runner.enqueue([...set, ...set]);
    await flush();
    expect(h.calls.map((c) => c.id)).toEqual(set.map((o) => o.id));
  });

  it("tapping Update preview twice, or while that outfit is being asked for, sends one refresh", async () => {
    const h = harness();
    h.runner.start();
    const busy = outfit(1);
    const outdated = outfit(2, OUTDATED);
    h.runner.enqueue([busy]);
    await flush();
    h.runner.refresh(outdated.id);
    h.runner.refresh(outdated.id);
    h.calls[0]!.resolve(ok({ ...busy, preview: READY }));
    await flush();
    h.runner.refresh(outdated.id); // in flight now
    await flush();
    h.calls[1]!.resolve(ok({ ...outdated, preview: READY }));
    await flush();
    expect(h.calls.map((c) => [c.id, c.refresh])).toEqual([
      [busy.id, false],
      [outdated.id, true],
    ]);
  });
});

describe("refine and swap: new outfits only", () => {
  it("skips ready, failed and outdated outfits in a new set; asks for none, skipped and pending ones", async () => {
    const h = harness();
    h.runner.start();
    const skipped: OutfitPreview = {
      ...NO_PREVIEW,
      status: "skipped",
      failureReason: "daily_cap_reached",
      presetId: PRESET,
    };
    const failed: OutfitPreview = {
      ...NO_PREVIEW,
      status: "failed",
      failureReason: "blocked",
      presetId: PRESET,
    };
    const set = [
      outfit(1, READY),
      outfit(2, failed),
      outfit(3, OUTDATED),
      outfit(4),
      outfit(5, skipped),
      outfit(6, PENDING),
    ];
    h.runner.enqueue(set);
    await flush();
    for (let i = 0; i < 3; i++) {
      h.calls[i]!.resolve(ok({ ...set[3 + i]!, preview: READY }));
      await flush();
    }
    expect(h.calls.map((c) => c.id)).toEqual([
      set[3]!.id,
      set[4]!.id,
      set[5]!.id,
    ]);
    // An outfit loaded mid-refresh is polled with refresh=true.
    h.runner.enqueue([outfit(7, REFRESHING)]);
    await flush();
    expect(h.calls.at(-1)).toMatchObject({ id: outfit(7).id, refresh: true });
  });
});

describe("navigation", () => {
  it("leaving mid-poll stops polling for good: the real sleep is cut short and no request follows", async () => {
    vi.useFakeTimers();
    const h = harness({ sleep: undefined, pollIntervalMs: 3000 });
    h.runner.start();
    const a = outfit(1);
    h.runner.enqueue([a]);
    await vi.advanceTimersByTimeAsync(0);
    h.calls[0]!.resolve(ok({ ...a, preview: PENDING }));
    await vi.advanceTimersByTimeAsync(10);
    h.runner.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.calls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("an answer arriving after leaving is dropped and nothing else is asked for", async () => {
    const h = harness();
    h.runner.start();
    const [a, b] = [outfit(1), outfit(2)];
    h.runner.enqueue([a, b]);
    await flush();
    h.runner.stop();
    h.calls[0]!.resolve(ok({ ...a, preview: READY }));
    await flush();
    expect(h.outfits).toEqual([]);
    expect(h.calls).toHaveLength(1);
  });

  it("a fresh screen (new runner) with every outfit ready asks for nothing", async () => {
    const h = harness();
    h.runner.start();
    h.runner.enqueue([outfit(1, READY), outfit(2, OUTDATED), outfit(3, READY)]);
    await flush();
    expect(h.calls).toHaveLength(0);
    expect(h.last()?.queuedIds ?? []).toEqual([]);
  });
});

describe("slow and stuck", () => {
  it("a preview pending forever stops at the maximum, says it's slow, and the queue moves on", async () => {
    const h = harness({ maxPolls: 4 });
    h.runner.start();
    const [stuck, next] = [outfit(1), outfit(2)];
    h.runner.enqueue([stuck, next]);
    for (
      let i = 0;
      i < 50 && h.calls.length > 0 && h.calls.at(-1)!.id === stuck.id;
      i++
    ) {
      await flush();
      const call = h.calls.at(-1)!;
      if (call.id !== stuck.id) break;
      call.resolve(ok({ ...stuck, preview: PENDING }));
    }
    await flush();
    const stuckCalls = h.calls.filter((c) => c.id === stuck.id).length;
    // maxPolls repeat asks after the first one; never unbounded.
    expect(stuckCalls).toBeLessThanOrEqual(5);
    expect(h.last().problems[stuck.id]).toEqual({ kind: "slow" });
    expect(h.calls.at(-1)!.id).toBe(next.id);

    const view = previewView(PENDING, h.runner.activityFor(h.last(), stuck.id));
    expect(view).toMatchObject({ kind: "collage", reason: "slow" });
    expect(view.kind === "collage" && view.note?.title).toBe(
      "This picture is taking a while",
    );
  });

  // Was BUG (low), fixed: a refresh still pending at the polling limit no
  // longer keeps "Updating…" up, and its note doesn't claim the pieces show.
  it(
    "a stuck refresh doesn't keep saying Updating… or claim the pieces are shown",
    async () => {
      const h = harness({ maxPolls: 2 });
      h.runner.start();
      const o = outfit(1, OUTDATED);
      h.runner.refresh(o.id);
      for (let i = 0; i < 10; i++) {
        await flush();
        const call = h.calls.at(-1);
        if (!call || h.last().queuedIds.length === 0) break;
        call.resolve(ok({ ...o, preview: REFRESHING }));
      }
      await flush();
      expect(h.last().problems[o.id]).toEqual({ kind: "slow" });
      const view = previewView(
        REFRESHING,
        h.runner.activityFor(h.last(), o.id),
      );
      expect(view.kind).toBe("image");
      if (view.kind !== "image") return;
      expect(view.note?.message ?? "").not.toMatch(/pieces/);
      expect(view.refreshing).toBe(false);
    },
  );
});

describe("refresh keeps the old picture", () => {
  it("shows Updating… from the tap, while queued behind another outfit, and the old URL throughout", async () => {
    const h = harness();
    h.runner.start();
    const busy = outfit(1);
    const o = outfit(2, OUTDATED);
    h.runner.enqueue([busy]);
    await flush();
    h.runner.refresh(o.id);
    let view = previewView(OUTDATED, h.runner.activityFor(h.last(), o.id));
    expect(view).toMatchObject({
      kind: "image",
      imageUrl: READY.imageUrl,
      refreshing: true,
      note: null,
    });
    h.calls[0]!.resolve(ok({ ...busy, preview: READY }));
    await flush();
    h.calls[1]!.resolve(ok({ ...o, preview: REFRESHING }));
    await flush();
    view = previewView(REFRESHING, h.runner.activityFor(h.last(), o.id));
    expect(view).toMatchObject({
      kind: "image",
      imageUrl: READY.imageUrl,
      refreshing: true,
    });
    const fresh: OutfitPreview = {
      ...READY,
      imageUrl: "https://x.supabase.co/sign/b.webp",
    };
    h.calls[2]!.resolve(ok({ ...o, preview: fresh }));
    await flush();
    expect(h.calls.map((c) => c.refresh)).toEqual([false, true, true]);
    view = previewView(fresh, h.runner.activityFor(h.last(), o.id));
    expect(view).toMatchObject({
      kind: "image",
      imageUrl: fresh.imageUrl,
      refreshing: false,
      outdated: false,
    });
  });

  it("a refresh refused for the cap keeps the old picture, says so in update wording, and halts the queue", async () => {
    const h = harness();
    h.runner.start();
    const o = outfit(1, OUTDATED);
    const rest = [outfit(2), outfit(3)];
    h.runner.refresh(o.id);
    h.runner.enqueue(rest);
    await flush();
    expect(h.calls[0]).toMatchObject({ id: o.id, refresh: true });
    h.calls[0]!.resolve(fail(CAP));
    await flush();
    expect(h.calls).toHaveLength(1);
    const view = previewView(OUTDATED, h.runner.activityFor(h.last(), o.id));
    expect(view).toMatchObject({
      kind: "image",
      imageUrl: READY.imageUrl,
      outdated: true,
      refreshing: false,
    });
    expect(view.kind === "image" && view.note?.message).toMatch(
      /The earlier picture stays for now/,
    );
    for (const r of rest)
      expect(h.last().problems[r.id]?.kind).toBe("daily_cap");
  });

  it("an outdated picture whose refresh fails gets the update failure note, and can be tried again", async () => {
    const h = harness();
    h.runner.start();
    const o = outfit(1, OUTDATED);
    h.runner.refresh(o.id);
    await flush();
    h.calls[0]!.resolve(fail({ code: "ai_failed", message: "No" }));
    await flush();
    let view = previewView(OUTDATED, h.runner.activityFor(h.last(), o.id));
    expect(view.kind === "image" && view.note?.title).toBe(
      "Couldn't update the picture",
    );
    h.runner.refresh(o.id);
    view = previewView(OUTDATED, h.runner.activityFor(h.last(), o.id));
    expect(view).toMatchObject({ kind: "image", note: null, refreshing: true });
    await flush();
    expect(h.calls).toHaveLength(2);
  });
});

describe("failure modes", () => {
  it("failed, capped and paused each get their own note; failure moves on, cap and pause stop the queue", async () => {
    for (const [error, kind, title, halts] of [
      [
        { code: "ai_failed", message: "x" } as ApiFailure,
        "failed",
        "We couldn't picture this one",
        false,
      ],
      [
        { code: "internal", message: "x" } as ApiFailure,
        "failed",
        "We couldn't picture this one",
        false,
      ],
      [CAP, "daily_cap", "That's today's outfit pictures used up", true],
      [PAUSED, "paused", "Outfit pictures are paused for now", true],
    ] as const) {
      const h = harness();
      h.runner.start();
      const [a, b, c] = [outfit(1), outfit(2), outfit(3)];
      h.runner.enqueue([a, b, c]);
      await flush();
      h.calls[0]!.resolve(fail(error));
      await flush();
      expect(h.calls.length, kind).toBe(halts ? 1 : 2);
      const view = previewView(
        NO_PREVIEW,
        h.runner.activityFor(h.last(), a.id),
      );
      expect(view).toMatchObject({ kind: "collage", reason: kind });
      expect(view.kind === "collage" && view.note?.title).toBe(title);
      if (halts) {
        for (const o of [b, c]) {
          expect(
            previewView(NO_PREVIEW, h.runner.activityFor(h.last(), o.id)),
          ).toMatchObject({ kind: "collage", reason: kind });
        }
        expect(h.last().queuedIds).toEqual([]);
      }
    }
  });

  it("a 200 with a stored failed or skipped preview shows the matching note without a runner problem", () => {
    const idle = { inProgress: false, awaitingPreset: false, problem: null };
    const cases = [
      [
        {
          ...NO_PREVIEW,
          status: "failed",
          failureReason: "blocked",
          presetId: PRESET,
        },
        "failed",
      ],
      [
        {
          ...NO_PREVIEW,
          status: "failed",
          failureReason: "invalid_image",
          presetId: PRESET,
        },
        "failed",
      ],
      [
        {
          ...NO_PREVIEW,
          status: "skipped",
          failureReason: "daily_cap_reached",
          presetId: PRESET,
        },
        "daily_cap",
      ],
      [
        {
          ...NO_PREVIEW,
          status: "skipped",
          failureReason: "ai_paused",
          presetId: PRESET,
        },
        "paused",
      ],
    ] as const;
    const titles = new Set<string>();
    for (const [preview, reason] of cases) {
      const view = previewView(preview as OutfitPreview, idle);
      expect(view).toMatchObject({ kind: "collage", reason });
      if (view.kind === "collage" && view.note) titles.add(view.note.title);
    }
    expect(titles.size).toBe(3);
  });

  it("a bad_request that isn't about the preset is a failure, not the Pick your model sheet", async () => {
    const h = harness();
    h.runner.start();
    h.runner.enqueue([outfit(1), outfit(2)]);
    await flush();
    h.calls[0]!.resolve(
      fail({
        code: "bad_request",
        message: "x",
        issues: [{ path: "refresh", message: "bad" }],
      }),
    );
    await flush();
    expect(h.last().needsPreset).toBe(false);
    expect(h.last().problems[outfit(1).id]?.kind).toBe("failed");
    expect(h.calls).toHaveLength(2);
  });

  it("a network failure while polling a pending preview ends in the failure note, not an endless spinner", async () => {
    const h = harness();
    h.runner.start();
    const a = outfit(1);
    h.runner.enqueue([a]);
    await flush();
    h.calls[0]!.resolve(ok({ ...a, preview: PENDING }));
    await flush();
    h.calls[1]!.resolve(fail({ code: "internal", message: "Network" }));
    await flush();
    expect(
      previewView(PENDING, h.runner.activityFor(h.last(), a.id)),
    ).toMatchObject({ kind: "collage", reason: "failed" });
  });
});

describe("Pick your model", () => {
  it("every queued outfit waits for the model; after resume they go in their original order, one at a time", async () => {
    const h = harness();
    h.runner.start();
    const set = [outfit(1), outfit(2), outfit(3)];
    h.runner.enqueue(set);
    await flush();
    h.calls[0]!.resolve(fail(NEEDS_PRESET));
    await flush();
    expect(h.last().needsPreset).toBe(true);
    for (const o of set)
      expect(h.runner.activityFor(h.last(), o.id)).toMatchObject({
        awaitingPreset: true,
        inProgress: false,
      });
    // More outfits arriving while the sheet is up don't send anything.
    h.runner.enqueue([outfit(4)]);
    h.runner.refresh(outfit(5, OUTDATED).id);
    await flush();
    expect(h.calls).toHaveLength(1);

    h.runner.resume();
    const order: string[] = [];
    for (let i = 1; i < 20 && h.calls[i]; i++) {
      order.push(h.calls[i]!.id);
      h.calls[i]!.resolve(
        ok({ ...outfit(1), id: h.calls[i]!.id, preview: READY }),
      );
      await flush();
    }
    expect(order).toEqual([
      outfit(5).id,
      outfit(1).id,
      outfit(2).id,
      outfit(3).id,
      outfit(4).id,
    ]);
    expect(h.maxInFlight()).toBe(1);
  });

  it("a settings check that says 'missing' asks nothing of the preview route until resume", async () => {
    const checkPreset = vi.fn().mockResolvedValue("missing");
    const h = harness({ checkPreset });
    h.runner.start();
    h.runner.enqueue([outfit(1)]);
    await flush();
    expect(h.calls).toHaveLength(0);
    expect(h.last().needsPreset).toBe(true);
    h.runner.resume();
    await flush();
    expect(h.calls).toHaveLength(1);
    // Checked once per screen, not per request.
    h.calls[0]!.resolve(ok({ ...outfit(1), preview: READY }));
    h.runner.enqueue([outfit(2)]);
    await flush();
    expect(checkPreset).toHaveBeenCalledTimes(1);
  });
});

describe("suggested-slot labels", () => {
  it("one label per slot, using the gap's subcategory, else the slot's singular name", () => {
    const labels = suggestedLabels(
      ["shoes", "outerwear"],
      [
        {
          category: "shoes",
          subcategory: "trainers",
          colours: ["white"],
          description: "White trainers",
          product: null,
        } as never,
      ],
    );
    expect(labels).toHaveLength(2);
    expect(labels[0]).toMatch(/^Trainers suggested$/);
    expect(labels[1]).toMatch(/ suggested$/);
    expect(labels[1]).not.toMatch(/^undefined/);
  });

  it("no slots, no labels", () => {
    expect(suggestedLabels([], [])).toEqual([]);
  });
});
