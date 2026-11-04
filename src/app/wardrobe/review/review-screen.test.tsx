// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ItemDraft, WardrobeItem } from "@/contracts";
import { keepBatchDraft } from "@/components/wardrobe/review/batch-drafts";
import { MOCK_ITEMS } from "@/lib/mocks/fixtures";
import { ReviewScreen } from "./review-screen";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock("@/lib/client/api", async (original) => {
  const actual = await original<typeof import("@/lib/client/api")>();
  return {
    ...actual,
    listItems: vi.fn(),
    markItemReviewed: vi.fn(),
    markItemsReviewed: vi.fn(),
    updateItemTags: vi.fn(),
    replaceItemPhoto: vi.fn(),
    createItem: vi.fn(),
  };
});
vi.mock("@/lib/client/photo", async (original) => ({
  ...(await original<typeof import("@/lib/client/photo")>()),
  prepareOriginal: vi.fn(async () => new Blob(["jpeg"], { type: "image/jpeg" })),
}));
const api = await import("@/lib/client/api");

const USER = "0a000000-0000-4000-8000-000000000001";
const toReview = (item: WardrobeItem, extra: Partial<WardrobeItem> = {}): WardrobeItem => ({ ...item, needsReview: true, ...extra });
const A = toReview(MOCK_ITEMS[0]!);
const B = toReview(MOCK_ITEMS[3]!);
const EMAIL = toReview(MOCK_ITEMS[6]!, { source: "email", needsPhoto: true });

beforeEach(() => {
  vi.mocked(api.listItems).mockResolvedValue([A, B, EMAIL]);
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.sessionStorage.clear();
});

describe("ReviewScreen", () => {
  it("lists the items to review (asking the API for needsReview=true)", async () => {
    render(<ReviewScreen userId={USER} />);
    expect(await screen.findByRole("heading", { name: "To review (3)" })).toBeInTheDocument();
    expect(api.listItems).toHaveBeenCalledWith({ needsReview: true });
    expect(screen.getByRole("listitem", { name: A.tags.description })).toBeInTheDocument();
  });

  it("'Looks right' confirms one item as it is and takes it off the list", async () => {
    const user = userEvent.setup();
    vi.mocked(api.markItemReviewed).mockResolvedValue({ ...A, needsReview: false });
    render(<ReviewScreen userId={USER} />);
    const card = await screen.findByRole("listitem", { name: A.tags.description });
    await user.click(within(card).getByRole("button", { name: "Looks right" }));
    expect(api.markItemReviewed).toHaveBeenCalledWith(A.id);
    expect(screen.queryByRole("listitem", { name: A.tags.description })).toBeNull();
    expect(screen.getByRole("heading", { name: "To review (2)" })).toBeInTheDocument();
  });

  it("'Confirm all' sends every listed item at once, then says all caught up", async () => {
    const user = userEvent.setup();
    vi.mocked(api.markItemsReviewed).mockResolvedValue(3);
    render(<ReviewScreen userId={USER} />);
    await user.click(await screen.findByRole("button", { name: "Confirm all 3" }));
    expect(api.markItemsReviewed).toHaveBeenCalledWith([A.id, B.id, EMAIL.id]);
    expect(await screen.findByText("All caught up")).toBeInTheDocument();
    expect(screen.getByText("Confirmed all 3 items.")).toBeInTheDocument();
  });

  it("a failed 'Confirm all' keeps the list and says why", async () => {
    const user = userEvent.setup();
    vi.mocked(api.markItemsReviewed).mockRejectedValue(new api.ApiClientError("internal", "Something went wrong on our side"));
    render(<ReviewScreen userId={USER} />);
    await user.click(await screen.findByRole("button", { name: "Confirm all 3" }));
    expect(await screen.findByText("Something went wrong on our side")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "To review (3)" })).toBeInTheDocument();
  });

  it("'Edit tags' corrects an item with the tag form (PATCH tags), then returns to the list", async () => {
    const user = userEvent.setup();
    vi.mocked(api.updateItemTags).mockImplementation(async (_id, tags) => ({ ...A, tags, needsReview: false }));
    render(<ReviewScreen userId={USER} />);
    const card = await screen.findByRole("listitem", { name: A.tags.description });
    await user.click(within(card).getByRole("button", { name: "Edit tags" }));
    const description = screen.getByRole("textbox", { name: /Description/ });
    await user.clear(description);
    await user.type(description, "My favourite tee");
    await user.click(screen.getByRole("button", { name: "Save tags" }));
    expect(api.updateItemTags).toHaveBeenCalledWith(A.id, expect.objectContaining({ description: "My favourite tee" }));
    expect(await screen.findByText("Saved: My favourite tee")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "To review (2)" })).toBeInTheDocument();
  });

  it("saving the edit form unchanged just confirms the item", async () => {
    const user = userEvent.setup();
    vi.mocked(api.markItemReviewed).mockResolvedValue({ ...A, needsReview: false });
    render(<ReviewScreen userId={USER} />);
    const card = await screen.findByRole("listitem", { name: A.tags.description });
    await user.click(within(card).getByRole("button", { name: "Edit tags" }));
    await user.click(screen.getByRole("button", { name: "Save tags" }));
    expect(api.updateItemTags).not.toHaveBeenCalled();
    expect(api.markItemReviewed).toHaveBeenCalledWith(A.id);
  });

  it("an email item without a picture offers 'Add a photo' (PUT /api/items/:id/photo)", async () => {
    const user = userEvent.setup();
    vi.mocked(api.replaceItemPhoto).mockResolvedValue({ ...EMAIL, needsPhoto: false, originalUrl: "/mock/items/uploaded.svg" });
    render(<ReviewScreen userId={USER} />);
    const card = await screen.findByRole("listitem", { name: EMAIL.tags.description });
    expect(within(card).getByText("No picture came with this one.")).toBeInTheDocument();
    expect(within(card).getByText("From an order email")).toBeInTheDocument();
    await user.upload(within(card).getByTestId("add-photo-input"), new File(["x"], "IMG_1.HEIC", { type: "image/heic" }));
    expect(api.replaceItemPhoto).toHaveBeenCalledWith(EMAIL.id, expect.objectContaining({ name: "IMG_1.jpg" }));
    expect(await screen.findByText("Photo added. Check the tags still match it.")).toBeInTheDocument();
    expect(within(card).queryByText("No picture came with this one.")).toBeNull();
  });

  it("drafts whose tagging failed are listed to fill in, and leave the list once saved", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listItems).mockResolvedValue([]);
    const draft: ItemDraft = {
      source: "photo",
      sourceUrl: null,
      originalImageKey: `${USER}/1b000000-0000-4000-8000-000000000001.jpg`,
      cutoutImageKey: null,
      originalUrl: "/mock/items/uploaded.svg",
      cutoutUrl: null,
      suggestedTags: null,
    };
    keepBatchDraft(USER, draft);
    vi.mocked(api.createItem).mockImplementation(async (req) => ({ ...A, tags: req.tags }));
    render(<ReviewScreen userId={USER} />);
    expect(await screen.findByRole("heading", { name: "Need tags (1)" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Fill in tags" }));
    expect(screen.getByRole("heading", { name: "Fill in the tags" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Back to the list" }));
    expect(screen.getByRole("heading", { name: "Need tags (1)" })).toBeInTheDocument();
  });

  it("says all caught up when there's nothing to review", async () => {
    vi.mocked(api.listItems).mockResolvedValue([]);
    render(<ReviewScreen userId={USER} />);
    expect(await screen.findByText("All caught up")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Confirm all/ })).toBeNull();
  });
});

describe("ReviewScreen: a draft whose photo has expired", () => {
  it("shows 'This photo has expired' with Discard, which drops the draft", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listItems).mockResolvedValue([]);
    const draft: ItemDraft = {
      source: "photo",
      sourceUrl: null,
      originalImageKey: `${USER}/1b000000-0000-4000-8000-000000000002.jpg`,
      cutoutImageKey: null,
      originalUrl: "/expired.jpg",
      cutoutUrl: null,
      suggestedTags: null,
    };
    keepBatchDraft(USER, draft);
    const { container } = render(<ReviewScreen userId={USER} />);
    await screen.findByRole("heading", { name: "Need tags (1)" });
    fireEvent.error(container.querySelector('img[src="/expired.jpg"]')!);
    expect(await screen.findByText(/This photo has expired/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Fill in tags" })).toBeNull();
    await user.click(screen.getByRole("button", { name: /^Discard/ }));
    expect(await screen.findByText("All caught up")).toBeInTheDocument();
  });
});
