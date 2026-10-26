// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountSheet, accountNavigation } from "./account-sheet";

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

let toSignIn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  toSignIn = vi.spyOn(accountNavigation, "toSignIn").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function openSheet() {
  const user = userEvent.setup();
  render(<AccountSheet email="cheryl@example.com" />);
  await user.click(screen.getByRole("button", { name: "Account" }));
  return { user, sheet: await screen.findByRole("dialog", { name: "Account" }) };
}

async function confirmDelete(user: ReturnType<typeof userEvent.setup>, sheet: HTMLElement) {
  await user.click(within(sheet).getByRole("button", { name: "Delete my account" }));
  const dialog = await screen.findByRole("alertdialog", { name: "Delete your account?" });
  await user.click(within(dialog).getByRole("button", { name: "Delete everything" }));
  return dialog;
}

describe("AccountSheet", () => {
  it("shows who is signed in and a sign-out form", async () => {
    const { sheet } = await openSheet();
    expect(within(sheet).getByText("Signed in as cheryl@example.com")).toBeInTheDocument();
    const signOut = within(sheet).getByRole("button", { name: "Sign out" });
    expect(signOut.closest("form")).toHaveAttribute("action", "/api/auth/sign-out");
    expect(signOut.closest("form")).toHaveAttribute("method", "post");
  });

  it("warns that photos, items and outfits all go, and that it can't be undone", async () => {
    const { user, sheet } = await openSheet();
    await user.click(within(sheet).getByRole("button", { name: "Delete my account" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Delete your account?" });
    expect(dialog).toHaveTextContent(/photos/);
    expect(dialog).toHaveTextContent(/every item/);
    expect(dialog).toHaveTextContent(/outfits/);
    expect(dialog).toHaveTextContent(/can't undo this/);
  });

  it("keeping the account deletes nothing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { user, sheet } = await openSheet();
    await user.click(within(sheet).getByRole("button", { name: "Delete my account" }));
    await user.click(await screen.findByRole("button", { name: "Keep my account" }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("on confirm, calls DELETE /api/account and goes to sign-in", async () => {
    const fetchMock = vi.fn(async () => json(200, { deleted: true }));
    vi.stubGlobal("fetch", fetchMock);
    const { user, sheet } = await openSheet();
    await confirmDelete(user, sheet);
    await waitFor(() => expect(toSignIn).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith("/api/account", expect.objectContaining({ method: "DELETE" }));
  });

  it("doesn't leave if the reply isn't the contract's { deleted: true }", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(200, { ok: true })));
    const { user, sheet } = await openSheet();
    const dialog = await confirmDelete(user, sheet);
    expect(await within(dialog).findByText(/sent back something unexpected/)).toBeInTheDocument();
    expect(toSignIn).not.toHaveBeenCalled();
  });

  it("says why and stays when deleting fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(500, { error: { code: "internal", message: "Something went wrong on our side" } })));
    const { user, sheet } = await openSheet();
    const dialog = await confirmDelete(user, sheet);
    expect(await within(dialog).findByText("Something went wrong on our side")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Delete everything" })).toBeEnabled();
    expect(toSignIn).not.toHaveBeenCalled();
  });
});
