// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ItemListResponseSchema, VerifyCodeResponseSchema } from "@/contracts";
import { apiRequest, listItems, signInPath, unauthorizedRedirect } from "./api";

function respond401() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify({ error: { code: "unauthorized", message: "Sign in to continue." } }), { status: 401 }),
    ),
  );
}

let navigate: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  navigate = vi.spyOn(unauthorizedRedirect, "navigate").mockImplementation(() => {});
  window.history.replaceState(null, "", "/wardrobe?category=shoes");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("signInPath", () => {
  it("comes back to the current page and says why", () => {
    expect(signInPath("/wardrobe?category=shoes")).toBe("/sign-in?next=%2Fwardrobe%3Fcategory%3Dshoes&reason=expired");
  });

  it("leaves out a pointless or looping next", () => {
    expect(signInPath("/")).toBe("/sign-in?reason=expired");
    expect(signInPath("/sign-in?next=%2Fadd")).toBe("/sign-in?reason=expired");
    expect(signInPath("//evil.example.com")).toBe("/sign-in?next=%2F%2Fevil.example.com&reason=expired");
  });
});

describe("an expired session", () => {
  it("sends the user to sign-in from wherever they are, and still rejects the call", async () => {
    respond401();
    await expect(listItems()).rejects.toMatchObject({ code: "unauthorized" });
    await tick();
    expect(navigate).toHaveBeenCalledWith("/sign-in?next=%2Fwardrobe&reason=expired");
  });

  it("leaves the query out of next, so a search never reaches whoever signs in next on this tab", async () => {
    window.history.replaceState(null, "", "/wardrobe?q=private%20words&category=shoes");
    respond401();
    await expect(listItems()).rejects.toMatchObject({ code: "unauthorized" });
    await tick();
    const url = navigate.mock.calls[0]?.[0] as string;
    expect(url).toBe("/sign-in?next=%2Fwardrobe&reason=expired");
    expect(url).not.toContain("private");
  });

  it("lets the screen's own catch run before leaving (the add flow keeps its draft there)", async () => {
    respond401();
    const order: string[] = [];
    navigate.mockImplementation(() => order.push("navigate"));
    await listItems().catch(() => order.push("catch"));
    await tick();
    expect(order).toEqual(["catch", "navigate"]);
  });

  it("isn't redirected where unauthorized means something else (a wrong sign-in code)", async () => {
    respond401();
    await expect(
      apiRequest(VerifyCodeResponseSchema, "/api/auth/verify-code", { method: "POST" }, { redirectOnUnauthorized: false }),
    ).rejects.toMatchObject({ code: "unauthorized" });
    await tick();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("other errors don't redirect", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { code: "not_found", message: "Gone" } }), { status: 404 })));
    await expect(apiRequest(ItemListResponseSchema, "/api/items")).rejects.toMatchObject({ code: "not_found" });
    await tick();
    expect(navigate).not.toHaveBeenCalled();
  });
});
