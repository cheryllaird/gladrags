// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EmailImport, UserSettings } from "@/contracts";
import { SettingsScreen } from "./settings-screen";

vi.mock("@/lib/client/api", async (original) => {
  const actual = await original<typeof import("@/lib/client/api")>();
  return {
    ...actual,
    getSettings: vi.fn(),
    updateFavouriteShops: vi.fn(),
    resetForwardingAddress: vi.fn(),
    listEmailImports: vi.fn(),
  };
});
const api = await import("@/lib/client/api");

const ADDRESS = "0123456789abcdef0123456789abcdef@inbound.gladrags.test";
const SETTINGS: UserSettings = { favouriteShopIds: ["next", "marks_and_spencer", "new_look"], forwardingAddress: ADDRESS };
const IMPORTS: EmailImport[] = [
  { id: "0a000000-0000-4000-8000-0000000000e1", receivedAt: "2026-10-30T10:00:00Z", shopName: "M&S", orderDate: "2026-10-30", status: "done", itemCount: 2, skippedCount: 0, error: null },
  { id: "0a000000-0000-4000-8000-0000000000e2", receivedAt: "2026-10-29T10:00:00Z", shopName: null, orderDate: null, status: "failed", itemCount: 0, skippedCount: 0, error: "sender_not_allowed" },
];

beforeEach(() => {
  vi.mocked(api.getSettings).mockResolvedValue(SETTINGS);
  vi.mocked(api.listEmailImports).mockResolvedValue(IMPORTS);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SettingsScreen", () => {
  it("shows the forwarding address with how to use it from the sign-in address", async () => {
    render(<SettingsScreen email="cheryl@example.com" />);
    expect(await screen.findByTestId("forwarding-address")).toHaveTextContent(ADDRESS);
    expect(screen.getByText(/Forward it to the address above, from cheryl@example.com/)).toBeInTheDocument();
  });

  it("copies the address", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<SettingsScreen email={null} />);
    await user.click(await screen.findByRole("button", { name: "Copy address" }));
    expect(writeText).toHaveBeenCalledWith(ADDRESS);
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("selects the address to copy by hand when the clipboard isn't allowed", async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn(async () => Promise.reject(new Error("denied"))) }, configurable: true });
    render(<SettingsScreen email={null} />);
    await user.click(await screen.findByRole("button", { name: "Copy address" }));
    expect(screen.getByText("Selected: copy it from the menu.")).toBeInTheDocument();
  });

  it("resets the address only after confirming", async () => {
    const user = userEvent.setup();
    const NEW = "fedcba9876543210fedcba9876543210@inbound.gladrags.test";
    vi.mocked(api.resetForwardingAddress).mockResolvedValue({ ...SETTINGS, forwardingAddress: NEW });
    render(<SettingsScreen email={null} />);
    await user.click(await screen.findByRole("button", { name: "Get a new address" }));
    expect(screen.getByRole("alertdialog", { name: "Get a new forwarding address?" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Keep this address" }));
    expect(api.resetForwardingAddress).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Get a new address" }));
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Get a new address" }));
    expect(api.resetForwardingAddress).toHaveBeenCalledTimes(1);
    expect(await screen.findByTestId("forwarding-address")).toHaveTextContent(NEW);
    expect(screen.getByText("You have a new address. The old one no longer works.")).toBeInTheDocument();
  });

  it("says email import isn't set up when there's no address", async () => {
    vi.mocked(api.getSettings).mockResolvedValue({ ...SETTINGS, forwardingAddress: null });
    render(<SettingsScreen email={null} />);
    expect(await screen.findByText(/Email import isn't set up yet/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy address" })).toBeNull();
  });

  it("lists recent email imports with their status and the reason one was refused", async () => {
    render(<SettingsScreen email={null} />);
    expect(await screen.findByText("Added 2 items to review")).toBeInTheDocument();
    expect(screen.getByText("Couldn't be added")).toBeInTheDocument();
    expect(screen.getByText("It wasn't forwarded from your sign-in address.")).toBeInTheDocument();
  });

  it("changes favourite shops from the contract's list, and needs at least one", async () => {
    const user = userEvent.setup();
    vi.mocked(api.updateFavouriteShops).mockImplementation(async (ids) => ({ ...SETTINGS, favouriteShopIds: [...ids] }));
    render(<SettingsScreen email={null} />);
    expect(await screen.findByRole("checkbox", { name: "Next" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Zara" })).not.toBeChecked();
    expect(screen.getAllByRole("checkbox")).toHaveLength(12);

    await user.click(screen.getByRole("checkbox", { name: "Zara" }));
    await user.click(screen.getByRole("button", { name: "Save shops" }));
    expect(api.updateFavouriteShops).toHaveBeenCalledWith(["next", "marks_and_spencer", "new_look", "zara"]);
    expect(await screen.findByText("Shops saved.")).toBeInTheDocument();

    for (const name of ["Next", "M&S", "New Look", "Zara"]) await user.click(screen.getByRole("checkbox", { name }));
    expect(screen.getByText("Pick at least one shop.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save shops" })).toBeDisabled();
  });
});
