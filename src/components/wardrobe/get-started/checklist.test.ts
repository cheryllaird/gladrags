// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Category } from "@/contracts";
import { MOCK_ITEMS } from "@/lib/mocks/fixtures";
import { checklistSteps, dismissChecklist, noteAddedSeveral, noteHasOutfit, readChecklistMemory, wardrobeIsStocked } from "./checklist";

const of = (...categories: Category[]) => categories.map((category) => ({ tags: { ...MOCK_ITEMS[0]!.tags, category } }));
const USER = "0a000000-0000-4000-8000-000000000001";

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("wardrobeIsStocked (when the checklist goes away)", () => {
  it("needs three tops, bottoms and shoes", () => {
    expect(wardrobeIsStocked(of("top", "top", "top", "bottom", "bottom", "bottom", "shoes", "shoes", "shoes"))).toBe(true);
    expect(wardrobeIsStocked(of("top", "top", "top", "bottom", "bottom", "bottom", "shoes", "shoes"))).toBe(false);
    expect(wardrobeIsStocked([])).toBe(false);
  });

  it("counts a dress towards both tops and bottoms; outerwear doesn't count", () => {
    expect(wardrobeIsStocked(of("dress_jumpsuit", "dress_jumpsuit", "dress_jumpsuit", "shoes", "shoes", "shoes"))).toBe(true);
    expect(wardrobeIsStocked(of("outerwear", "outerwear", "outerwear", "shoes", "shoes", "shoes"))).toBe(false);
  });

  it("the mock wardrobe is stocked, so the checklist stays out of the way there", () => {
    expect(wardrobeIsStocked(MOCK_ITEMS)).toBe(true);
  });
});

describe("checklistSteps", () => {
  const steps = (input: Partial<Parameters<typeof checklistSteps>[0]>) =>
    Object.fromEntries(checklistSteps({ items: [], addedSeveral: false, hasOutfit: false, ...input }).map((s) => [s.id, s.done]));

  it("nothing done on an empty wardrobe", () => {
    expect(steps({})).toEqual({ first_item: false, several: false, email: false, outfit: false });
  });

  it("ticks each step from what it can see", () => {
    expect(steps({ items: [{ source: "photo", needsReview: false }] })).toMatchObject({ first_item: true, several: false });
    expect(steps({ items: [{ source: "link", needsReview: true }] })).toMatchObject({ several: true });
    expect(steps({ items: [{ source: "email", needsReview: true }] })).toMatchObject({ several: false, email: true });
    expect(steps({ addedSeveral: true })).toMatchObject({ several: true });
    expect(steps({ hasOutfit: true })).toMatchObject({ outfit: true });
  });
});

describe("checklist memory (per user, per device)", () => {
  it("remembers a dismissal and a batch for that user only", () => {
    dismissChecklist(USER);
    noteAddedSeveral(USER);
    noteHasOutfit(USER);
    expect(readChecklistMemory(USER)).toEqual({ dismissed: true, addedSeveral: true, hasOutfit: true });
    expect(readChecklistMemory("someone-else")).toEqual({ dismissed: false, addedSeveral: false, hasOutfit: false });
    expect(readChecklistMemory(null)).toEqual({ dismissed: false, addedSeveral: false, hasOutfit: false });
  });

  it("reads junk as nothing remembered", () => {
    window.localStorage.setItem(`gladrags-checklist:${USER}`, "{not json");
    expect(readChecklistMemory(USER)).toEqual({ dismissed: false, addedSeveral: false, hasOutfit: false });
    window.localStorage.setItem(`gladrags-checklist:${USER}`, JSON.stringify({ dismissed: "yes" }));
    expect(readChecklistMemory(USER).dismissed).toBe(false);
  });

  it("never throws when storage is blocked", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => dismissChecklist(USER)).not.toThrow();
    expect(readChecklistMemory(USER)).toEqual({ dismissed: false, addedSeveral: false, hasOutfit: false });
  });
});
