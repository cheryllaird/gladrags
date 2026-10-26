// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearGladragsSessionStorage } from "./session-storage";

afterEach(() => {
  window.sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("clearGladragsSessionStorage", () => {
  it("removes every gladrags:* key and nothing else", () => {
    window.sessionStorage.setItem("gladrags:pending-add", "{}");
    window.sessionStorage.setItem("gladrags:wardrobe-search", "?category=top");
    window.sessionStorage.setItem("gladrags:anything-new", "x");
    window.sessionStorage.setItem("someone-else", "keep");
    clearGladragsSessionStorage();
    expect(window.sessionStorage.length).toBe(1);
    expect(window.sessionStorage.getItem("someone-else")).toBe("keep");
  });

  it("doesn't throw when storage is blocked", () => {
    vi.spyOn(Storage.prototype, "key").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    window.sessionStorage.setItem("gladrags:pending-add", "{}");
    expect(() => clearGladragsSessionStorage()).not.toThrow();
  });
});
