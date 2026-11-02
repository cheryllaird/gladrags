// @vitest-environment jsdom
// QA (milestone 5, C5): the review list against a stubbed fetch, so the real
// API client (and its "Confirm all" chunking) runs.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ItemDraft, WardrobeItem } from "@/contracts";
import { BATCH_DRAFTS_KEY, keepBatchDraft } from "@/components/wardrobe/review/batch-drafts";
import { MOCK_ITEMS } from "@/lib/mocks/fixtures";
import { ReviewScreen } from "./review-screen";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

// 100+ review cards take a few seconds to render in jsdom on a loaded machine.
vi.setConfig({ testTimeout: 30_000 });

const USER = "0a000000-0000-4000-8000-000000000001";
const OTHER = "0a000000-0000-4000-8000-000000000002";

function manyItems(n: number): WardrobeItem[] {
  return Array.from({ length: n }, (_, i) => {
    const base = MOCK_ITEMS[i % MOCK_ITEMS.length]!;
    const id = `0a000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`;
    return { ...base, id, needsReview: true, tags: { ...base.tags, description: `Item number ${i + 1}` } };
  });
}

const draft = (user: string, n: number): ItemDraft => ({
  source: "photo",
  sourceUrl: null,
  originalImageKey: `${user}/1b000000-0000-4000-8000-00000000000${n}.jpg`,
  cutoutImageKey: null,
  originalUrl: "/mock/items/uploaded.svg",
  cutoutUrl: null,
  suggestedTags: null,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

interface Call {
  method: string;
  url: string;
  body: unknown;
}

function stubFetch(items: WardrobeItem[], options: { failReviewedChunk?: number; failPatch?: boolean } = {}) {
  const calls: Call[] = [];
  let reviewedChunk = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      calls.push({ method, url, body });
      if (url.startsWith("/api/items?")) return json({ items });
      if (url === "/api/items/reviewed") {
        reviewedChunk++;
        if (reviewedChunk === options.failReviewedChunk) {
          return json({ error: { code: "internal", message: "Something went wrong on our side." } }, 500);
        }
        return json({ updated: (body as { itemIds: string[] }).itemIds.length });
      }
      if (method === "PATCH") {
        if (options.failPatch) return json({ error: { code: "internal", message: "Something went wrong on our side." } }, 500);
        const id = url.split("/").pop();
        const item = items.find((i) => i.id === id)!;
        return json({ item: { ...item, needsReview: false } });
      }
      return json({ error: { code: "not_found", message: "Not found" } }, 404);
    }),
  );
  return calls;
}

beforeEach(() => {
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
});

describe("review list: Confirm all", () => {
  it("with 250 items sends three requests of at most 100 and then says all caught up", async () => {
    const user = userEvent.setup();
    const items = manyItems(250);
    const calls = stubFetch(items);
    render(<ReviewScreen userId={USER} />);
    expect(await screen.findByRole("heading", { name: "To review (250)" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Confirm all 250" }));
    expect(await screen.findByText("All caught up")).toBeInTheDocument();
    const chunks = calls.filter((c) => c.url === "/api/items/reviewed").map((c) => (c.body as { itemIds: string[] }).itemIds);
    expect(chunks.map((c) => c.length)).toEqual([100, 100, 50]);
    expect(new Set(chunks.flat()).size).toBe(250);
    expect(screen.getByText("Confirmed all 250 items.")).toBeInTheDocument();
  });

  it("exactly 100 items is one request", async () => {
    const user = userEvent.setup();
    const calls = stubFetch(manyItems(100));
    render(<ReviewScreen userId={USER} />);
    await user.click(await screen.findByRole("button", { name: "Confirm all 100" }));
    await screen.findByText("All caught up");
    expect(calls.filter((c) => c.url === "/api/items/reviewed")).toHaveLength(1);
  });

  it("a failure part-way says why and keeps the button usable", async () => {
    const user = userEvent.setup();
    stubFetch(manyItems(150), { failReviewedChunk: 2 });
    render(<ReviewScreen userId={USER} />);
    await user.click(await screen.findByRole("button", { name: "Confirm all 150" }));
    expect(await screen.findByText("Something went wrong on our side.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Confirm all/ })).toBeEnabled();
  });

  // Low, reported: the first 100 were confirmed on the server, but the list
  // (and its count) still shows all 150 until it's reloaded.
  it.fails("after a part-way failure, the list drops the items the server already confirmed", async () => {
    const user = userEvent.setup();
    stubFetch(manyItems(150), { failReviewedChunk: 2 });
    render(<ReviewScreen userId={USER} />);
    await user.click(await screen.findByRole("button", { name: "Confirm all 150" }));
    await screen.findByText("Something went wrong on our side.");
    expect(screen.getByRole("heading", { name: "To review (50)" })).toBeInTheDocument();
  });

  it("drafts aren't sent with Confirm all and stay to fill in", async () => {
    const user = userEvent.setup();
    keepBatchDraft(USER, draft(USER, 1));
    const items = manyItems(2);
    const calls = stubFetch(items);
    render(<ReviewScreen userId={USER} />);
    await user.click(await screen.findByRole("button", { name: "Confirm all 2" }));
    expect(await screen.findByText("Confirmed all 2 items.")).toBeInTheDocument();
    const sent = calls.find((c) => c.url === "/api/items/reviewed")!.body as { itemIds: string[] };
    expect(sent.itemIds).toEqual(items.map((i) => i.id));
    expect(screen.getByRole("heading", { name: "Need tags (1)" })).toBeInTheDocument();
    expect(screen.queryByText("All caught up")).toBeNull();
  });

  it("a single item has no Confirm all (Looks right does it)", async () => {
    stubFetch(manyItems(1));
    render(<ReviewScreen userId={USER} />);
    await screen.findByRole("heading", { name: "To review (1)" });
    expect(screen.queryByRole("button", { name: /Confirm all/ })).toBeNull();
  });
});

describe("review list: one at a time", () => {
  it("a failed 'Looks right' keeps the item and says why", async () => {
    const user = userEvent.setup();
    const items = manyItems(2);
    stubFetch(items, { failPatch: true });
    render(<ReviewScreen userId={USER} />);
    const card = await screen.findByRole("listitem", { name: "Item number 1" });
    await user.click(within(card).getByRole("button", { name: "Looks right" }));
    expect(await screen.findByText("Something went wrong on our side.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "To review (2)" })).toBeInTheDocument();
  });

  it("the count stays in step as items are confirmed one by one", async () => {
    const user = userEvent.setup();
    stubFetch(manyItems(3));
    render(<ReviewScreen userId={USER} />);
    for (const [n, left] of [[1, 2], [2, 1]] as const) {
      const card = await screen.findByRole("listitem", { name: `Item number ${n}` });
      await user.click(within(card).getByRole("button", { name: "Looks right" }));
      expect(await screen.findByRole("heading", { name: `To review (${left})` })).toBeInTheDocument();
    }
    await user.click(within(screen.getByRole("listitem", { name: "Item number 3" })).getByRole("button", { name: "Looks right" }));
    expect(await screen.findByText("All caught up")).toBeInTheDocument();
  });
});

describe("review list: drafts kept in this tab", () => {
  it("another user's drafts in this tab are never shown", async () => {
    window.sessionStorage.setItem(
      BATCH_DRAFTS_KEY,
      JSON.stringify({ userId: OTHER, drafts: [{ draft: draft(OTHER, 1), addedAt: Date.now() }] }),
    );
    stubFetch([]);
    render(<ReviewScreen userId={USER} />);
    expect(await screen.findByText("All caught up")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /Need tags/ })).toBeNull();
  });

  it("drafts claiming this user but with another user's image keys are never shown", async () => {
    window.sessionStorage.setItem(
      BATCH_DRAFTS_KEY,
      JSON.stringify({ userId: USER, drafts: [{ draft: draft(OTHER, 1), addedAt: Date.now() }] }),
    );
    stubFetch([]);
    render(<ReviewScreen userId={USER} />);
    expect(await screen.findByText("All caught up")).toBeInTheDocument();
  });

  it("expired drafts are dropped", async () => {
    window.sessionStorage.setItem(
      BATCH_DRAFTS_KEY,
      JSON.stringify({ userId: USER, drafts: [{ draft: draft(USER, 1), addedAt: Date.now() - 21 * 60 * 60 * 1000 }] }),
    );
    stubFetch([]);
    render(<ReviewScreen userId={USER} />);
    expect(await screen.findByText("All caught up")).toBeInTheDocument();
  });

  it("no drafts without a known user", async () => {
    keepBatchDraft(USER, draft(USER, 1));
    stubFetch([]);
    render(<ReviewScreen userId={null} />);
    expect(await screen.findByText("All caught up")).toBeInTheDocument();
  });

  it("with session storage blocked the list still loads", async () => {
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    stubFetch(manyItems(2));
    render(<ReviewScreen userId={USER} />);
    expect(await screen.findByRole("heading", { name: "To review (2)" })).toBeInTheDocument();
    spy.mockRestore();
  });
});
