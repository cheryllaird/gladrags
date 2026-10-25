import { describe, expect, it } from "vitest";
import type { Outfit } from "@/contracts";
import { outfitsForFilter } from "./saved-filter";

const outfit = (id: string, status: Outfit["status"]) => ({ id, status }) as Outfit;
const ids = (outfits: Outfit[]) => outfits.map((o) => o.id);

describe("outfitsForFilter", () => {
  const outfits = [outfit("a", "saved"), outfit("b", "liked")];

  it("All shows everything", () => {
    expect(ids(outfitsForFilter(outfits, "all", {}))).toEqual(["a", "b"]);
  });

  it("filters by the status each outfit loaded with", () => {
    expect(ids(outfitsForFilter(outfits, "saved", {}))).toEqual(["a"]);
    expect(ids(outfitsForFilter(outfits, "liked", {}))).toEqual(["b"]);
  });

  it("an outfit changed from liked to saved here shows under Saved", () => {
    expect(ids(outfitsForFilter(outfits, "saved", { b: "saved" }))).toEqual(["a", "b"]);
  });

  it("and stays under Liked for this visit, so it doesn't vanish under your thumb", () => {
    expect(ids(outfitsForFilter(outfits, "liked", { b: "saved" }))).toEqual(["b"]);
  });

  it("an outfit un-saved here stays under Saved for this visit", () => {
    expect(ids(outfitsForFilter(outfits, "saved", { a: "suggested" }))).toEqual(["a"]);
  });
});
