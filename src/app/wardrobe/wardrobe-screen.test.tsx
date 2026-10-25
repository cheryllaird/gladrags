// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
    const items = MOCK_ITEMS.filter((i) => !category || i.tags.category === category)
      .filter((i) => !colour || (i.tags.colours as string[]).includes(colour))
      .filter((i) => !q || i.tags.description.toLowerCase().includes(q));
    return new Response(JSON.stringify({ items }), { status: 200, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function requestedQueries(fetchMock: ReturnType<typeof stubItemsApi>): string[] {
  return fetchMock.mock.calls.map(([input]) => String(input));
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
    render(<WardrobeScreen initialFilters={{ ...NO_FILTERS, category: "shoes" }} />);
    expect(await screen.findByText("3 items match")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Category" })).toHaveValue("shoes");
    expect(requestedQueries(fetchMock)).toEqual(["/api/items?category=shoes"]);
  });

  it("offers to clear filters when nothing matches", async () => {
    const user = userEvent.setup();
    stubItemsApi();
    render(<WardrobeScreen initialFilters={{ ...NO_FILTERS, q: "sequins" }} />);
    expect(await screen.findByText("Nothing matches those filters.")).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: "Clear filters" })[0]!);
    expect(await screen.findByText(`${MOCK_ITEMS.length} items`)).toBeInTheDocument();
  });

  it("shows an empty wardrobe with a way to add the first item", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ items: [] }), { status: 200 })));
    render(<WardrobeScreen initialFilters={NO_FILTERS} />);
    expect(await screen.findByText("Your wardrobe is empty")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Add your first item" })).toHaveAttribute("href", "/add");
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
