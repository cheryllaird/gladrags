// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MOCK_ITEMS } from "@/lib/mocks/fixtures";
import { NO_FILTERS } from "@/components/wardrobe/wardrobe-filter-values";
import { WardrobeScreen } from "./wardrobe-screen";

// Next's Link needs the app router outside a Next app; a plain anchor will do here.
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

/** Answers GET /api/items like the mock route: filters applied to the fixture wardrobe. */
function stubItemsApi() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    const category = url.searchParams.get("category");
    const colour = url.searchParams.get("colour");
    const q = url.searchParams.get("q")?.toLowerCase();
    const needsReview = url.searchParams.get("needsReview");
    const items = MOCK_ITEMS.filter((i) => !category || i.tags.category === category)
      .filter((i) => needsReview === null || String(i.needsReview) === needsReview)
      .filter((i) => !colour || (i.tags.colours as string[]).includes(colour))
      .filter((i) => !q || i.tags.description.toLowerCase().includes(q));
    return new Response(JSON.stringify({ items }), { status: 200, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** The wardrobe list requests, leaving out the review banner's count (?needsReview=true). */
function requestedQueries(fetchMock: ReturnType<typeof stubItemsApi>): string[] {
  return fetchMock.mock.calls.map(([input]) => String(input)).filter((url) => !url.includes("needsReview="));
}

beforeEach(() => {
  window.history.replaceState(null, "", "/wardrobe");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("WardrobeScreen filters", () => {
  it("shows the whole wardrobe at first", async () => {
    const fetchMock = stubItemsApi();
    render(<WardrobeScreen initialFilters={NO_FILTERS} />);
    expect(await screen.findByText(`${MOCK_ITEMS.length} items`)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Camel wool overcoat" })).toHaveAttribute("href", "/wardrobe/1a000000-0000-4000-8000-000000000009");
    expect(requestedQueries(fetchMock)).toEqual(["/api/items"]);
  });

  it("asks the API for the chosen category and colour, and keeps them in the URL", async () => {
    const user = userEvent.setup();
    const fetchMock = stubItemsApi();
    render(<WardrobeScreen initialFilters={NO_FILTERS} />);
    await screen.findByText(`${MOCK_ITEMS.length} items`);

    await user.selectOptions(screen.getByRole("combobox", { name: "Category" }), "Bottom");
    expect(await screen.findByText("3 items match")).toBeInTheDocument();
    await user.selectOptions(screen.getByRole("combobox", { name: "Colour" }), "Tan");
    expect(await screen.findByText("1 item match")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Tan slim chinos" })).toBeInTheDocument();

    expect(requestedQueries(fetchMock)).toContain("/api/items?category=bottom&colour=tan");
    expect(window.location.search).toBe("?category=bottom&colour=tan");
  });

  it("searches descriptions after a pause in typing, not on every key", async () => {
    const user = userEvent.setup();
    const fetchMock = stubItemsApi();
    render(<WardrobeScreen initialFilters={NO_FILTERS} />);
    await screen.findByText(`${MOCK_ITEMS.length} items`);

    await user.type(screen.getByRole("searchbox", { name: "Search descriptions" }), "chinos");
    expect(await screen.findByText("1 item match")).toBeInTheDocument();
    const searches = requestedQueries(fetchMock).filter((q) => q.includes("q="));
    expect(searches).toEqual(["/api/items?q=chinos"]);
  });

  it("starts from filters in the page URL", async () => {
    const fetchMock = stubItemsApi();
    window.history.replaceState(null, "", "/wardrobe?category=shoes");
    render(<WardrobeScreen initialFilters={{ ...NO_FILTERS, category: "shoes" }} />);
    expect(await screen.findByText("3 items match")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Category" })).toHaveValue("shoes");
    expect(requestedQueries(fetchMock)).toEqual(["/api/items?category=shoes"]);
  });

  it("offers to clear filters when nothing matches", async () => {
    const user = userEvent.setup();
    stubItemsApi();
    window.history.replaceState(null, "", "/wardrobe?q=sequins");
    render(<WardrobeScreen initialFilters={{ ...NO_FILTERS, q: "sequins" }} />);
    expect(await screen.findByText("Nothing matches those filters.")).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: "Clear filters" })[0]!);
    expect(await screen.findByText(`${MOCK_ITEMS.length} items`)).toBeInTheDocument();
  });

  it("shows an empty wardrobe with a way to add the first item", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ items: [] }), { status: 200 })));
    render(<WardrobeScreen initialFilters={NO_FILTERS} />);
    expect(await screen.findByText("Your wardrobe is empty")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Add your first item/ })).toHaveAttribute("href", "/add");
  });

  it("shows an error with a retry when the wardrobe can't load", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { code: "internal", message: "Something went wrong on our side" } }), { status: 500 })));
    render(<WardrobeScreen initialFilters={NO_FILTERS} />);
    expect(await screen.findByText("Something went wrong on our side")).toBeInTheDocument();

    stubItemsApi();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByText(`${MOCK_ITEMS.length} items`)).toBeInTheDocument());
  });
});

describe("WardrobeScreen and expiring image URLs", () => {
  function itemsRequests(fetchMock: ReturnType<typeof stubItemsApi>) {
    return requestedQueries(fetchMock).filter((q) => q.startsWith("/api/items"));
  }

  it("refetches the wardrobe once when an image fails to load (its signed URL may have expired)", async () => {
    const fetchMock = stubItemsApi();
    const { container } = render(<WardrobeScreen initialFilters={NO_FILTERS} />);
    await screen.findByText(`${MOCK_ITEMS.length} items`);
    expect(itemsRequests(fetchMock)).toHaveLength(1);

    // Every image fails, as they would once the hour is up: still only one refetch.
    for (const img of container.querySelectorAll("img")) fireEvent.error(img);
    await waitFor(() => expect(itemsRequests(fetchMock)).toHaveLength(2));
    await screen.findByText(`${MOCK_ITEMS.length} items`);

    // An image that is broken for good can't make it loop.
    for (const img of container.querySelectorAll("img")) fireEvent.error(img);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(itemsRequests(fetchMock)).toHaveLength(2);
  });

  it("refetches when the app comes back after the data is about an hour old, not before", async () => {
    const now = vi.spyOn(Date, "now");
    const start = 1_800_000_000_000;
    now.mockReturnValue(start);
    const fetchMock = stubItemsApi();
    render(<WardrobeScreen initialFilters={NO_FILTERS} />);
    await screen.findByText(`${MOCK_ITEMS.length} items`);

    now.mockReturnValue(start + 10 * 60 * 1000);
    document.dispatchEvent(new Event("visibilitychange"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(itemsRequests(fetchMock)).toHaveLength(1);

    now.mockReturnValue(start + 51 * 60 * 1000);
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(itemsRequests(fetchMock)).toHaveLength(2));
    now.mockRestore();
  });

});

describe("WardrobeScreen and the address bar", () => {
  it("puts the search in the address at once, before the search itself runs", async () => {
    const user = userEvent.setup();
    stubItemsApi();
    render(<WardrobeScreen initialFilters={NO_FILTERS} />);
    await screen.findByText(`${MOCK_ITEMS.length} items`);
    await user.type(screen.getByRole("searchbox", { name: "Search descriptions" }), "tan");
    // No waiting for the debounce: an item tapped now must come back to this.
    expect(window.location.search).toBe("?q=tan");
  });

  it("takes its filters from the address, even if the server-rendered props are older (Back from an item)", async () => {
    const fetchMock = stubItemsApi();
    window.history.replaceState(null, "", "/wardrobe?category=shoes&q=leather");
    render(<WardrobeScreen initialFilters={NO_FILTERS} />);
    expect(await screen.findByText("1 item match")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Category" })).toHaveValue("shoes");
    expect(screen.getByRole("searchbox", { name: "Search descriptions" })).toHaveValue("leather");
    expect(requestedQueries(fetchMock)).toEqual(["/api/items?category=shoes&q=leather"]);
    expect(window.location.search).toBe("?category=shoes&q=leather");
  });

  it("drops unknown filter values from the address", async () => {
    stubItemsApi();
    window.history.replaceState(null, "", "/wardrobe?category=hats");
    render(<WardrobeScreen initialFilters={NO_FILTERS} />);
    await screen.findByText(`${MOCK_ITEMS.length} items`);
    expect(window.location.search).toBe("");
  });
});

describe("WardrobeScreen: review banner and get-started checklist (milestone 5)", () => {
  const USER = "0a000000-0000-4000-8000-000000000001";

  /** Items from `items`, and nothing for outfits; ?needsReview=true answers with `toReview`. */
  function stub(items: typeof MOCK_ITEMS, toReview: typeof MOCK_ITEMS = []) {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.startsWith("/api/outfits") ? { outfits: [] } : { items: url.includes("needsReview=true") ? toReview : items };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  afterEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it("shows 'Review N new items' when items are waiting, linking to the review list", async () => {
    const fetchMock = stub(MOCK_ITEMS.map((i, n) => (n < 2 ? { ...i, needsReview: true } : i)));
    render(<WardrobeScreen initialFilters={NO_FILTERS} userId={USER} />);
    const banner = await screen.findByRole("link", { name: /Review 2 new items/ });
    expect(banner).toHaveAttribute("href", "/wardrobe/review");
    // Counted from the unfiltered list: no separate request.
    expect(fetchMock.mock.calls.map(([u]) => String(u)).filter((u) => u.includes("needsReview"))).toEqual([]);
  });

  it("with filters on, asks the API for the count", async () => {
    const waiting = MOCK_ITEMS.slice(0, 3).map((i) => ({ ...i, needsReview: true }));
    const fetchMock = stub(MOCK_ITEMS.slice(0, 1), waiting);
    window.history.replaceState(null, "", "/wardrobe?category=top");
    render(<WardrobeScreen initialFilters={{ ...NO_FILTERS, category: "top" }} userId={USER} />);
    expect(await screen.findByRole("link", { name: /Review 3 new items/ })).toBeInTheDocument();
    expect(fetchMock.mock.calls.map(([u]) => String(u))).toContain("/api/items?needsReview=true");
  });

  it("asks for outfits until one has been seen, then remembers it and stops asking", async () => {
    const outfitsAsked = () => vi.mocked(fetch).mock.calls.filter(([u]) => String(u).startsWith("/api/outfits")).length;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.startsWith("/api/outfits") ? { outfits: [{}] } : { items: MOCK_ITEMS.slice(0, 1) };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    window.localStorage.setItem(`gladrags-checklist:${USER}`, JSON.stringify({ hasOutfit: true }));
    render(<WardrobeScreen initialFilters={NO_FILTERS} userId={USER} />);
    expect(await screen.findByText("2 of 4 done")).toBeInTheDocument();
    expect(outfitsAsked()).toBe(0);
  });

  it("shows no banner when nothing is waiting, and no checklist on a stocked wardrobe", async () => {
    stub(MOCK_ITEMS);
    render(<WardrobeScreen initialFilters={NO_FILTERS} userId={USER} />);
    await screen.findByText(`${MOCK_ITEMS.length} items`);
    expect(screen.queryByRole("link", { name: /new item/ })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Get started" })).toBeNull();
  });

  it("an empty wardrobe gets the checklist instead of a grid, with its four steps and progress", async () => {
    stub([]);
    render(<WardrobeScreen initialFilters={NO_FILTERS} userId={USER} />);
    expect(await screen.findByRole("heading", { name: "Your wardrobe is empty" })).toBeInTheDocument();
    expect(screen.getByText("0 of 4 done")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Add several at once/ })).toHaveAttribute("href", "/add");
    expect(screen.getByRole("link", { name: /Forward an order email/ })).toHaveAttribute("href", "/settings#order-emails");
    expect(screen.getByRole("link", { name: /Get your first outfit/ })).toHaveAttribute("href", "/outfits");
    expect(screen.getAllByText(/Outfits work from your first item/).length).toBeGreaterThan(0);
  });

  it("a nearly empty wardrobe shows the checklist above the grid, with the first step ticked", async () => {
    stub(MOCK_ITEMS.slice(0, 2));
    render(<WardrobeScreen initialFilters={NO_FILTERS} userId={USER} />);
    expect(await screen.findByRole("heading", { name: "Get started" })).toBeInTheDocument();
    expect(screen.getByText("1 of 4 done")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Add your first item/ })).toBeNull();
    expect(screen.getByText("2 items")).toBeInTheDocument();
  });

  it("can be dismissed, and stays dismissed for this user on this device", async () => {
    const user = userEvent.setup();
    stub(MOCK_ITEMS.slice(0, 2));
    render(<WardrobeScreen initialFilters={NO_FILTERS} userId={USER} />);
    await user.click(await screen.findByRole("button", { name: "Hide the get-started checklist" }));
    expect(screen.queryByRole("heading", { name: "Get started" })).toBeNull();
    cleanup();

    render(<WardrobeScreen initialFilters={NO_FILTERS} userId={USER} />);
    await screen.findByText("2 items");
    expect(screen.queryByRole("heading", { name: "Get started" })).toBeNull();
    cleanup();

    // Another user on the same device still sees theirs.
    render(<WardrobeScreen initialFilters={NO_FILTERS} userId="0a000000-0000-4000-8000-000000000002" />);
    expect(await screen.findByRole("heading", { name: "Get started" })).toBeInTheDocument();
  });

  it("isn't shown on a filtered wardrobe", async () => {
    stub(MOCK_ITEMS.slice(0, 1));
    window.history.replaceState(null, "", "/wardrobe?category=top");
    render(<WardrobeScreen initialFilters={{ ...NO_FILTERS, category: "top" }} userId={USER} />);
    await screen.findByText("1 item match");
    expect(screen.queryByRole("heading", { name: "Get started" })).toBeNull();
  });

  it("still works with storage blocked", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    stub([]);
    render(<WardrobeScreen initialFilters={NO_FILTERS} userId={USER} />);
    expect(await screen.findByRole("heading", { name: "Your wardrobe is empty" })).toBeInTheDocument();
    vi.restoreAllMocks();
  });
});
