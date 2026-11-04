// @vitest-environment jsdom
// QA (milestone 5, C5): settings failure paths and email import statuses.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EmailImport, EmailImportError, UserSettings } from "@/contracts";
import { EMAIL_IMPORT_REASONS, emailImportStatus } from "@/components/settings/email-import-copy";
import { ApiClientError } from "@/lib/client/api";
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
const boom = () => new ApiClientError("internal", "Something went wrong on our side.", { status: 500 });

let n = 0;
function entry(partial: Partial<EmailImport>): EmailImport {
  n++;
  return {
    id: `0a000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`,
    receivedAt: "2026-10-30T10:00:00Z",
    shopName: "Next",
    orderDate: null,
    status: "done",
    itemCount: 1,
    skippedCount: 0,
    error: null,
    ...partial,
  };
}

beforeEach(() => {
  vi.mocked(api.getSettings).mockResolvedValue(SETTINGS);
  vi.mocked(api.listEmailImports).mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("settings: loading", () => {
  it("a failed load offers Try again, which recovers", async () => {
    const user = userEvent.setup();
    vi.mocked(api.getSettings).mockRejectedValueOnce(boom());
    render(<SettingsScreen email={null} />);
    await user.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByTestId("forwarding-address")).toHaveTextContent(ADDRESS);
  });

  it("without the sign-in address the copy says 'your sign-in address'", async () => {
    render(<SettingsScreen email={null} />);
    expect(await screen.findByText(/Forward it to the address above, from your sign-in address\./)).toBeInTheDocument();
  });

  it("a null address hides copy, reset and the email history, and still lists shops", async () => {
    vi.mocked(api.getSettings).mockResolvedValue({ ...SETTINGS, forwardingAddress: null });
    render(<SettingsScreen email={null} />);
    expect(await screen.findByText(/Email import isn.t set up yet/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy address" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Get a new address" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Favourite shops" })).toBeInTheDocument();
    // Changed after review: no email history until forwarding is set up.
    expect(screen.queryByRole("heading", { name: "Recent order emails" })).toBeNull();
  });
});

describe("settings: copying the address", () => {
  it("with no clipboard API at all, selects the address instead", async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    render(<SettingsScreen email={null} />);
    await user.click(await screen.findByRole("button", { name: "Copy address" }));
    expect(screen.getByText("Selected: copy it from the menu.")).toBeInTheDocument();
    expect(window.getSelection()?.toString()).toBe(ADDRESS);
  });
});

describe("settings: resetting the address", () => {
  it("a failed reset keeps the dialog open with the reason and the old address", async () => {
    const user = userEvent.setup();
    vi.mocked(api.resetForwardingAddress).mockRejectedValueOnce(boom());
    render(<SettingsScreen email={null} />);
    await user.click(await screen.findByRole("button", { name: "Get a new address" }));
    const dialog = screen.getByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Get a new address" }));
    expect(await within(dialog).findByText("Something went wrong on our side.")).toBeInTheDocument();
    expect(screen.getByTestId("forwarding-address")).toHaveTextContent(ADDRESS);
  });

  // Fixed after review: the error from a failed reset used to show again
  // when the dialog was reopened.
  it("reopening the dialog after a failed reset doesn't show the old error", async () => {
    const user = userEvent.setup();
    vi.mocked(api.resetForwardingAddress).mockRejectedValueOnce(boom());
    render(<SettingsScreen email={null} />);
    await user.click(await screen.findByRole("button", { name: "Get a new address" }));
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Get a new address" }));
    await screen.findByText("Something went wrong on our side.");
    await user.click(screen.getByRole("button", { name: "Keep this address" }));
    await user.click(await screen.findByRole("button", { name: "Get a new address" }));
    expect(within(screen.getByRole("alertdialog")).queryByText("Something went wrong on our side.")).toBeNull();
  });
});

describe("settings: favourite shops", () => {
  it("unticking every shop disables saving and sends nothing; ticking one back allows it", async () => {
    const user = userEvent.setup();
    vi.mocked(api.updateFavouriteShops).mockResolvedValue({ ...SETTINGS, favouriteShopIds: ["zara"] });
    render(<SettingsScreen email={null} />);
    for (const name of ["Next", "M&S", "New Look"]) await user.click(await screen.findByRole("checkbox", { name }));
    expect(screen.getByRole("alert")).toHaveTextContent("Pick at least one shop.");
    expect(screen.getByRole("button", { name: "Save shops" })).toBeDisabled();
    expect(api.updateFavouriteShops).not.toHaveBeenCalled();

    await user.click(screen.getByRole("checkbox", { name: "Zara" }));
    await user.click(screen.getByRole("button", { name: "Save shops" }));
    expect(api.updateFavouriteShops).toHaveBeenCalledWith(["zara"]);
    expect(await screen.findByText("Shops saved.")).toBeInTheDocument();
  });

  it("putting the choice back as it was hides the Save button", async () => {
    const user = userEvent.setup();
    render(<SettingsScreen email={null} />);
    await user.click(await screen.findByRole("checkbox", { name: "Zara" }));
    expect(screen.getByRole("button", { name: "Save shops" })).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "Zara" }));
    expect(screen.queryByRole("button", { name: "Save shops" })).toBeNull();
  });

  it("a failed save keeps the choice and says why", async () => {
    const user = userEvent.setup();
    vi.mocked(api.updateFavouriteShops).mockRejectedValueOnce(boom());
    render(<SettingsScreen email={null} />);
    await user.click(await screen.findByRole("checkbox", { name: "Zara" }));
    await user.click(screen.getByRole("button", { name: "Save shops" }));
    expect(await screen.findByText("Something went wrong on our side.")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Zara" })).toBeChecked();
    expect(screen.getByRole("button", { name: "Save shops" })).toBeEnabled();
  });

  it("saves in the list's order, whatever the tap order", async () => {
    const user = userEvent.setup();
    vi.mocked(api.updateFavouriteShops).mockImplementation(async (ids) => ({ ...SETTINGS, favouriteShopIds: [...ids] }));
    render(<SettingsScreen email={null} />);
    await user.click(await screen.findByRole("checkbox", { name: "FatFace" }));
    await user.click(screen.getByRole("checkbox", { name: "Zara" }));
    await user.click(screen.getByRole("button", { name: "Save shops" }));
    expect(api.updateFavouriteShops).toHaveBeenCalledWith(["next", "marks_and_spencer", "new_look", "zara", "fatface"]);
  });
});

describe("settings: email import statuses", () => {
  it("shows processing, done, partly skipped, nothing found and refused emails", async () => {
    vi.mocked(api.listEmailImports).mockResolvedValue([
      entry({ status: "processing", itemCount: 0 }),
      entry({ status: "done", itemCount: 1 }),
      entry({ status: "done", itemCount: 2, skippedCount: 3, error: "daily_cap_reached" }),
      entry({ status: "done", itemCount: 0, error: "no_items_found", shopName: null }),
      entry({ status: "failed", itemCount: 0, error: "failed_checks" }),
    ]);
    render(<SettingsScreen email={null} />);
    expect(await screen.findByText("Adding the items…")).toBeInTheDocument();
    expect(screen.getByText("Added 1 item to review")).toBeInTheDocument();
    expect(screen.getByText("Added 2 items to review; 3 items left out")).toBeInTheDocument();
    expect(screen.getByText(EMAIL_IMPORT_REASONS.daily_cap_reached)).toBeInTheDocument();
    expect(screen.getByText("No items added")).toBeInTheDocument();
    expect(screen.getByText(EMAIL_IMPORT_REASONS.no_items_found)).toBeInTheDocument();
    expect(screen.getByText(/An email/)).toBeInTheDocument();
    expect(screen.getByText(EMAIL_IMPORT_REASONS.failed_checks)).toBeInTheDocument();
  });

  it("a failed list says why, and Refresh tries again", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listEmailImports).mockRejectedValueOnce(boom()).mockResolvedValue([entry({})]);
    render(<SettingsScreen email={null} />);
    expect(await screen.findByText("Something went wrong on our side.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Refresh the list of order emails" }));
    expect(await screen.findByText("Added 1 item to review")).toBeInTheDocument();
  });

  it("every error code has plain words, whatever the status", () => {
    const errors = Object.keys(EMAIL_IMPORT_REASONS) as EmailImportError[];
    expect(errors.sort()).toEqual(
      ["ai_failed", "ai_paused", "daily_cap_reached", "failed_checks", "internal", "no_items_found", "sender_not_allowed"].sort(),
    );
    for (const error of errors) {
      expect(emailImportStatus({ status: "failed", itemCount: 0, skippedCount: 0, error })).toEqual({
        summary: "Couldn't be added",
        reason: EMAIL_IMPORT_REASONS[error],
      });
    }
    // Done with nothing skipped: no reason line, even if one was recorded.
    expect(emailImportStatus({ status: "done", itemCount: 2, skippedCount: 0, error: "ai_failed" }).reason).toBeNull();
  });
});
