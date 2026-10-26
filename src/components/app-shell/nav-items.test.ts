import { describe, expect, it } from "vitest";
import { NAV_ITEMS, activeNavHref, showsAppChrome } from "./nav-items";

describe("bottom navigation", () => {
  it("links to Wardrobe, Add, Outfits and Saved in that order", () => {
    expect(NAV_ITEMS.map((i) => [i.label, i.href])).toEqual([
      ["Wardrobe", "/wardrobe"],
      ["Add", "/add"],
      ["Outfits", "/outfits"],
      ["Saved", "/outfits/saved"],
    ]);
  });

  it.each([
    ["/", "/wardrobe"],
    ["/wardrobe", "/wardrobe"],
    ["/wardrobe/1a000000-0000-4000-8000-000000000001", "/wardrobe"],
    ["/add", "/add"],
    ["/add/link", "/add"],
    ["/outfits", "/outfits"],
    ["/outfits/123", "/outfits"],
    ["/outfits/saved", "/outfits/saved"],
    ["/somewhere-else", null],
    ["/wardrobes", null],
  ])("highlights the right tab on %s", (pathname, expected) => {
    expect(activeNavHref(pathname)).toBe(expected);
  });

  it("is hidden on the signed-out screens only", () => {
    expect(showsAppChrome("/sign-in")).toBe(false);
    expect(showsAppChrome("/auth/callback")).toBe(false);
    expect(showsAppChrome("/wardrobe")).toBe(true);
    expect(showsAppChrome("/sign-in-help")).toBe(true);
  });
});
