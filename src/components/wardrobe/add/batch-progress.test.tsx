// @vitest-environment jsdom
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ItemDraft } from "@/contracts";
import type { BatchEntryState, BatchOutcome } from "@/lib/client/add-item";
import { MOCK_ITEMS } from "@/lib/mocks/fixtures";
import { BatchProgress, type BatchRow } from "./batch-progress";
import { LEAVE_MESSAGES, leaveConfirm, useBatch } from "./use-batch";

const USER = "0a000000-0000-4000-8000-000000000001";
const DRAFT: ItemDraft = {
  source: "photo",
  sourceUrl: null,
  originalImageKey: `${USER}/1b000000-0000-4000-8000-000000000001.jpg`,
  cutoutImageKey: null,
  originalUrl: "/mock/items/uploaded.svg",
  cutoutUrl: null,
  suggestedTags: null,
};
const shot = (url: string): BatchEntryState => ({ kind: "needs_screenshot", sourceUrl: url, message: "Couldn't read it." });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.sessionStorage.clear();
});

describe("BatchProgress", () => {
  it("while one screenshot uploads, the other rows' buttons wait", () => {
    const rows: BatchRow[] = [
      { label: "a.example/p", state: { kind: "pending", stage: "uploading" } },
      { label: "b.example/p", state: shot("https://b.example/p") },
    ];
    render(<BatchProgress kind="link" rows={rows} running={false} stoppedBy={null} onScreenshot={() => {}} />);
    expect(screen.getByRole("button", { name: "Add a screenshot: b.example/p" })).toBeDisabled();
  });

  it("the screenshot buttons work once nothing is uploading", () => {
    const rows: BatchRow[] = [
      { label: "a.example/p", state: shot("https://a.example/p") },
      { label: "b.example/p", state: shot("https://b.example/p") },
    ];
    render(<BatchProgress kind="link" rows={rows} running={false} stoppedBy={null} onScreenshot={() => {}} />);
    for (const button of screen.getAllByRole("button", { name: /^Add a screenshot/ })) expect(button).toBeEnabled();
  });

  it("a draft that couldn't be kept says 'Fill this in now' and opens the fill-in from its row", async () => {
    const user = userEvent.setup();
    const onRowChange = vi.fn();
    const rows: BatchRow[] = [{ label: "Photo 1", state: { kind: "draft", draft: DRAFT }, unkeptDraft: true }];
    render(<BatchProgress kind="photo" rows={rows} running={false} stoppedBy={null} userId={USER} onRowChange={onRowChange} />);
    expect(screen.getByText(/Fill this in now/)).toBeInTheDocument();
    expect(screen.getByText(/fill in the tags below now/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Fill in tags: Photo 1" }));
    expect(screen.getByRole("button", { name: "Save to wardrobe" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(onRowChange).toHaveBeenCalledWith(0, { kind: "not_added" });
  });
});

describe("useBatch", () => {
  function pendingRun() {
    let finish!: (outcome: BatchOutcome) => void;
    const start = vi.fn(() => new Promise<BatchOutcome>((resolve) => (finish = resolve)));
    return { start, finish: (o: Partial<BatchOutcome> = {}) => finish({ states: [], stoppedBy: null, aborted: false, ...o }) };
  }

  it("never runs two batches at once", async () => {
    const { result } = renderHook(() => useBatch(USER, "photo"));
    const first = pendingRun();
    const second = pendingRun();
    let done!: Promise<void>;
    act(() => {
      done = result.current.run(["Photo 1"], 0, first.start);
    });
    await act(async () => {
      await result.current.run(["Photo 1"], 0, second.start);
    });
    expect(second.start).not.toHaveBeenCalled();
    await act(async () => {
      first.finish();
      await done;
    });
  });

  it("asks before an in-app link is followed while running, and not after", async () => {
    const ask = vi.spyOn(leaveConfirm, "ask").mockReturnValue(false);
    const link = document.createElement("a");
    link.href = "/wardrobe";
    document.body.appendChild(link);
    const { result } = renderHook(() => useBatch(USER, "photo"));
    const run = pendingRun();
    let done!: Promise<void>;
    act(() => {
      done = result.current.run(["Photo 1"], 0, run.start);
    });
    const click = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    link.dispatchEvent(click);
    expect(ask).toHaveBeenCalledWith(LEAVE_MESSAGES.photo);
    expect(click.defaultPrevented).toBe(true);

    await act(async () => {
      run.finish();
      await done;
    });
    ask.mockClear();
    // (jsdom can't navigate; stop the link itself after the guard has had its turn.)
    link.addEventListener("click", (event) => event.preventDefault());
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    expect(ask).not.toHaveBeenCalled();
    link.remove();
  });

  it("drops the leave-page guard as soon as the batch stops (before a sign-in redirect)", async () => {
    const { result } = renderHook(() => useBatch(USER, "photo"));
    const run = pendingRun();
    let done!: Promise<void>;
    act(() => {
      done = result.current.run(["Photo 1"], 0, run.start);
    });
    const during = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(during);
    expect(during.defaultPrevented).toBe(true);
    // The batch stops on unauthorized; the guard is off before React re-renders.
    run.finish({ stoppedBy: new Error("unauthorized") });
    await done;
    const after = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });

  it("aborts the batch when the screen unmounts", () => {
    const { result, unmount } = renderHook(() => useBatch(USER, "link"));
    let signal: AbortSignal | null = null;
    act(() => {
      void result.current.run(["a"], 0, (_onChange, s) => {
        signal = s;
        return new Promise(() => {});
      });
    });
    expect(signal!.aborted).toBe(false);
    unmount();
    expect(signal!.aborted).toBe(true);
  });

  it("flags a draft that couldn't be kept (storage blocked)", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const { result } = renderHook(() => useBatch(USER, "photo"));
    act(() => {
      void result.current.run(["Photo 1"], 0, () => new Promise(() => {}));
    });
    act(() => result.current.setRow(0, { kind: "draft", draft: DRAFT }));
    expect(result.current.batch!.rows[0]).toMatchObject({ unkeptDraft: true });
    act(() => result.current.setRow(0, { kind: "saved", item: MOCK_ITEMS[0]! }));
    expect(result.current.batch!.rows[0]).toMatchObject({ unkeptDraft: false });
  });
});
