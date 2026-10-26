// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MOCK_ITEMS } from "@/lib/mocks/fixtures";
import { rememberWardrobeSearch } from "@/components/wardrobe/wardrobe-return";
import { ItemDetailScreen } from "./item-detail-screen";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const { router } = vi.hoisted(() => ({ router: { replace: vi.fn(), refresh: vi.fn(), push: vi.fn() } }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const DRESS = MOCK_ITEMS.find((i) => i.tags.description === "Green floral wrap midi dress")!;

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Answers the item routes; `first` overrides the first GET. */
function stubItemApi(first?: Response) {
  let gets = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "DELETE") return json(200, { deleted: true });
    gets++;
    if (gets === 1 && first) return first;
    return json(200, { item: DRESS });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, gets: () => gets };
}

beforeEach(() => {
  window.sessionStorage.clear();
  router.replace.mockClear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ItemDetailScreen", () => {
  it("shows formality with its name, from the contract's number", async () => {
    stubItemApi();
    render(<ItemDetailScreen id={DRESS.id} />);
    expect(await screen.findByText("4 · Smart")).toBeInTheDocument();
  });

  it("offers Try again as well as Back when the item can't load", async () => {
    const user = userEvent.setup();
    const api = stubItemApi(json(500, { error: { code: "internal", message: "Something went wrong on our side" } }));
    render(<ItemDetailScreen id={DRESS.id} />);
    expect(await screen.findByText("Something went wrong on our side")).toBeInTheDocument();
    expect(within(screen.getByRole("alert")).getByRole("link", { name: "Back to wardrobe" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: DRESS.tags.description })).toBeInTheDocument();
    expect(api.gets()).toBe(2);
  });

  it("doesn't offer Try again for an item that isn't there", async () => {
    stubItemApi(json(404, { error: { code: "not_found", message: "That item wasn't found" } }));
    render(<ItemDetailScreen id={DRESS.id} />);
    expect(await screen.findByText(/isn't in your wardrobe/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("fetches the item again, once, when its image fails (an expired signed URL)", async () => {
    const api = stubItemApi();
    render(<ItemDetailScreen id={DRESS.id} />);
    const image = await screen.findByRole("img", { name: DRESS.tags.description });
    fireEvent.error(image);
    await waitFor(() => expect(api.gets()).toBe(2));

    fireEvent.error(await screen.findByRole("img", { name: DRESS.tags.description }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(api.gets()).toBe(2);
  });

  it("after deleting, goes back to the wardrobe with the filters the user came from", async () => {
    const user = userEvent.setup();
    stubItemApi();
    rememberWardrobeSearch("?category=dress_jumpsuit&q=floral");
    render(<ItemDetailScreen id={DRESS.id} />);
    await user.click(await screen.findByRole("button", { name: "Delete" }));
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete item" }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/wardrobe?category=dress_jumpsuit&q=floral"));
  });

  it("after deleting with no remembered filters, goes to the plain wardrobe", async () => {
    const user = userEvent.setup();
    stubItemApi();
    render(<ItemDetailScreen id={DRESS.id} />);
    await user.click(await screen.findByRole("button", { name: "Delete" }));
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete item" }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/wardrobe"));
  });
});
