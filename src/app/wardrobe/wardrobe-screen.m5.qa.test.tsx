// @vitest-environment jsdom
// QA (milestone 5, C5): the review banner's count and the get-started
// checklist's threshold and dismissal, on the wardrobe screen.
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Category, ItemDraft, WardrobeItem } from "@/contracts";
import { NO_FILTERS } from "@/components/wardrobe/wardrobe-filter-values";
import { BATCH_DRAFTS_KEY, keepBatchDraft } from "@/components/wardrobe/review/batch-drafts";
import { MOCK_ITEMS } from "@/lib/mocks/fixtures";
import { WardrobeScreen } from "./wardrobe-screen";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const USER = "0a000000-0000-4000-8000-000000000001";
const OTHER = "0a000000-0000-4000-8000-000000000002";

function of(...categories: Category[]): WardrobeItem[] {
  return categories.map((category, i) => {
    // A real mock item of that category, so its subcategory matches.
    const base = MOCK_ITEMS.find((item) => item.tags.category === category)!;
    return {
      ...base,
      id: `0a000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
      tags: { ...base.tags, description: `Thing ${i + 1}` },
    };
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

function stub(items: readonly WardrobeItem[], toReview: readonly WardrobeItem[] = []) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.startsWith("/api/outfits") ? { outfits: [] } : { items: url.includes("needsReview=true") ? toReview : items };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/");
});

describe("review banner count", () => {
  it("adds this user's batch drafts to the items still to review", async () => {
    keepBatchDraft(USER, draft(USER, 1));
    keepBatchDraft(USER, draft(USER, 2));
    stub(MOCK_ITEMS, MOCK_ITEMS.slice(0, 3).map((i) => ({ ...i, needsReview: true })));
    render(<WardrobeScreen initialFilters={NO_FILTERS} userId={USER} />);
    expect(await screen.findByRole("link", { name: /Review 5 new items/ })).toBeInTheDocument();
  });

  it("ignores another user's drafts left in the tab", async () => {
    window.sessionStorage.setItem(
      BATCH_DRAFTS_KEY,
      JSON.stringify({ userId: OTHER, drafts: [{ draft: draft(OTHER, 1), addedAt: Date.now() }] }),
    );
    stub(MOCK_ITEMS);
    render(<WardrobeScreen initialFilters={NO_FILTERS} userId={USER} />);
    await screen.findByText(`${MOCK_ITEMS.length} items`);
    expect(screen.queryByRole("link", { name: /new item/ })).toBeNull();
  });

  it("drafts alone show the banner (singular), and it updates when a draft is kept in this tab", async () => {
    stub(MOCK_ITEMS);
    render(<WardrobeScreen initialFilters={NO_FILTERS} userId={USER} />);
    await screen.findByText(`${MOCK_ITEMS.length} items`);
    act(() => keepBatchDraft(USER, draft(USER, 1)));
    expect(await screen.findByRole("link", { name: /Review 1 new item(?!s)/ })).toBeInTheDocument();
  });
});

describe("get-started checklist threshold", () => {
  it("still shows with 3 tops, 3 bottoms and 2 shoes", async () => {
    stub(of("top", "top", "top", "bottom", "bottom", "bottom", "shoes", "shoes"));
    render(<WardrobeScreen initialFilters={NO_FILTERS} userId={USER} />);
    expect(await screen.findByRole("heading", { name: "Get started" })).toBeInTheDocument();
  });

  it("hides at 3 of each", async () => {
    stub(of("top", "top", "top", "bottom", "bottom", "bottom", "shoes", "shoes", "shoes"));
    render(<WardrobeScreen initialFilters={NO_FILTERS} userId={USER} />);
    await screen.findByText("9 items");
    expect(screen.queryByRole("heading", { name: "Get started" })).toBeNull();
  });

  it("hides at 3 dresses and 3 shoes; lots of outerwear doesn't count", async () => {
    stub(of("dress_jumpsuit", "dress_jumpsuit", "dress_jumpsuit", "shoes", "shoes", "shoes"));
    render(<WardrobeScreen initialFilters={NO_FILTERS} userId={USER} />);
    await screen.findByText("6 items");
    expect(screen.queryByRole("heading", { name: "Get started" })).toBeNull();
    cleanup();

    stub(of(...Array.from({ length: 20 }, () => "outerwear" as const), "shoes", "shoes", "shoes"));
    render(<WardrobeScreen initialFilters={NO_FILTERS} userId={USER} />);
    expect(await screen.findByRole("heading", { name: "Get started" })).toBeInTheDocument();
  });

  it("ignores junk in storage and still shows", async () => {
    window.localStorage.setItem(`gladrags-checklist:${USER}`, "null");
    stub([]);
    render(<WardrobeScreen initialFilters={NO_FILTERS} userId={USER} />);
    expect(await screen.findByRole("heading", { name: "Your wardrobe is empty" })).toBeInTheDocument();
  });

  it("another user's dismissal on this device doesn't hide it", async () => {
    window.localStorage.setItem(`gladrags-checklist:${OTHER}`, JSON.stringify({ dismissed: true, addedSeveral: true }));
    stub([]);
    render(<WardrobeScreen initialFilters={NO_FILTERS} userId={USER} />);
    expect(await screen.findByRole("heading", { name: "Your wardrobe is empty" })).toBeInTheDocument();
    expect(screen.getByText("0 of 4 done")).toBeInTheDocument();
  });

  // Medium, reported: with storage blocked (Safari private browsing, say) the
  // "Hide" button does nothing at all, since dismissal is only read back from
  // localStorage. It should at least hide for this visit.
  it.fails("'Hide' works for this visit even with storage blocked", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const user = userEvent.setup();
    stub(of("top"));
    render(<WardrobeScreen initialFilters={NO_FILTERS} userId={USER} />);
    await user.click(await screen.findByRole("button", { name: "Hide the get-started checklist" }));
    expect(screen.queryByRole("heading", { name: "Get started" })).toBeNull();
  });
});
