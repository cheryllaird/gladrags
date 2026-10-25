import { describe, expect, it } from "vitest";
import { checkComposition, type Category } from "@/contracts";
import { COLLAGE_SIZE, fitContain, layoutCollage, opaqueBounds, type Box, type CollageItem, type CollageLayout } from "./collage-layout";

const item = (category: Category, id: string = category): CollageItem => ({
  id,
  category,
  imageUrl: `/mock/items/${id}.svg`,
  label: id,
});

const TOP = item("top");
const BOTTOM = item("bottom");
const DRESS = item("dress_jumpsuit", "dress");
const SHOES = item("shoes");
const OUTERWEAR = item("outerwear");

/** Every shape the composition rule allows, menswear and womenswear alike. */
const COMPOSITIONS: Record<string, CollageItem[]> = {
  "top + bottom + shoes": [TOP, BOTTOM, SHOES],
  "top + bottom + shoes + outerwear": [TOP, BOTTOM, SHOES, OUTERWEAR],
  "dress + shoes": [DRESS, SHOES],
  "dress + shoes + outerwear": [DRESS, SHOES, OUTERWEAR],
};

const centreX = (b: Box) => b.x + b.width / 2;
const bottomEdge = (b: Box) => b.y + b.height;
const boxOf = (layout: CollageLayout, id: string) => {
  const placed = layout.placed.find((p) => p.id === id);
  if (!placed) throw new Error(`${id} wasn't placed`);
  return placed.box;
};

describe("layoutCollage: every valid composition", () => {
  for (const [name, items] of Object.entries(COMPOSITIONS)) {
    describe(name, () => {
      const layout = layoutCollage(items);

      it("is a valid outfit by the shared rule (sanity check on the fixture)", () => {
        expect(checkComposition(items.map((i) => i.category))).toEqual({ ok: true });
      });

      it("places every item, once", () => {
        expect(layout.unplaced).toEqual([]);
        expect(layout.placed.map((p) => p.id).sort()).toEqual(items.map((i) => i.id).sort());
      });

      it("keeps every box inside the canvas", () => {
        for (const { box } of layout.placed) {
          expect(box.x).toBeGreaterThanOrEqual(0);
          expect(box.y).toBeGreaterThanOrEqual(0);
          expect(box.x + box.width).toBeLessThanOrEqual(layout.width);
          expect(box.y + box.height).toBeLessThanOrEqual(layout.height);
          expect(box.width).toBeGreaterThan(0);
          expect(box.height).toBeGreaterThan(0);
        }
      });

      it("puts shoes at the foot, below everything else", () => {
        const shoes = boxOf(layout, "shoes");
        for (const p of layout.placed.filter((p) => p.slot !== "feet")) {
          expect(shoes.y).toBeGreaterThanOrEqual(bottomEdge(p.box) - 1);
        }
        expect(bottomEdge(shoes)).toBeGreaterThan(layout.height * 0.9);
      });

      it("draws back to front: outerwear first, shoes last", () => {
        const order = layout.placed.map((p) => p.slot);
        const expected = (["side", "lower", "upper", "feet"] as const).filter((s) => order.includes(s));
        expect(order).toEqual(expected);
      });

      it("lines the body column up: top or dress, bottom and shoes share one centre", () => {
        const column = layout.placed.filter((p) => p.slot !== "side").map((p) => centreX(p.box));
        for (const x of column) expect(Math.abs(x - column[0]!)).toBeLessThanOrEqual(1);
      });
    });
  }
});

describe("layoutCollage: separates", () => {
  it("top + bottom + shoes: top upper centre, bottom below it, shoes at the foot", () => {
    const layout = layoutCollage([SHOES, BOTTOM, TOP]); // input order doesn't matter
    expect(layout.shape).toBe("separates");
    expect(layout.hasOuterwear).toBe(false);

    const top = boxOf(layout, "top");
    const bottom = boxOf(layout, "bottom");
    const shoes = boxOf(layout, "shoes");
    expect(top.y).toBeLessThan(bottom.y);
    expect(bottom.y).toBeLessThan(shoes.y);
    expect(top.y).toBeLessThan(layout.height * 0.1);
    // Centred on the canvas when there's no outerwear.
    expect(Math.abs(centreX(top) - layout.width / 2)).toBeLessThanOrEqual(1);
    // The waistband tucks just under the top: a small overlap, no more.
    expect(bottomEdge(top) - bottom.y).toBeGreaterThanOrEqual(0);
    expect(bottomEdge(top) - bottom.y).toBeLessThan(layout.height * 0.05);
  });

  it("with outerwear: the body moves left and the outerwear sits to the right", () => {
    const layout = layoutCollage(COMPOSITIONS["top + bottom + shoes + outerwear"]!);
    expect(layout.hasOuterwear).toBe(true);

    const top = boxOf(layout, "top");
    const coat = boxOf(layout, "outerwear");
    expect(centreX(top)).toBeLessThan(layout.width / 2);
    expect(centreX(coat)).toBeGreaterThan(layout.width / 2);
    expect(coat.x).toBeGreaterThan(centreX(top));
    // Beside the top and bottom, not down by the shoes.
    expect(coat.y).toBeLessThan(boxOf(layout, "bottom").y);
    expect(bottomEdge(coat)).toBeLessThan(boxOf(layout, "shoes").y);
  });
});

describe("layoutCollage: dress or jumpsuit", () => {
  it("dress + shoes: one tall box from the top of the canvas down to the shoes", () => {
    const separates = layoutCollage(COMPOSITIONS["top + bottom + shoes"]!);
    const layout = layoutCollage(COMPOSITIONS["dress + shoes"]!);
    expect(layout.shape).toBe("one_piece");
    expect(layout.placed.map((p) => p.slot)).toEqual(["upper", "feet"]);

    const dress = boxOf(layout, "dress");
    // Covers the space a top and bottom would use together.
    expect(dress.y).toBe(boxOf(separates, "top").y);
    expect(bottomEdge(dress)).toBe(bottomEdge(boxOf(separates, "bottom")));
    expect(Math.abs(centreX(dress) - layout.width / 2)).toBeLessThanOrEqual(1);
  });

  it("dress + shoes + outerwear: same side position as with separates", () => {
    const separates = layoutCollage(COMPOSITIONS["top + bottom + shoes + outerwear"]!);
    const layout = layoutCollage(COMPOSITIONS["dress + shoes + outerwear"]!);
    expect(boxOf(layout, "outerwear")).toEqual(boxOf(separates, "outerwear"));
    expect(centreX(boxOf(layout, "dress"))).toBeLessThan(layout.width / 2);
  });

  it("a jumpsuit lays out exactly like a dress (only the category matters)", () => {
    const jumpsuit = { ...DRESS, id: "jumpsuit", label: "Black jumpsuit" };
    const a = layoutCollage([DRESS, SHOES]).placed.map((p) => p.box);
    const b = layoutCollage([jumpsuit, SHOES]).placed.map((p) => p.box);
    expect(b).toEqual(a);
  });
});

describe("layoutCollage: menswear and womenswear look the same", () => {
  it("positions depend on category alone, not on the item", () => {
    const mens = [item("top", "oxford-shirt"), item("bottom", "chinos"), item("shoes", "loafers"), item("outerwear", "blazer")];
    const womens = [item("top", "blouse"), item("bottom", "skirt"), item("shoes", "heels"), item("outerwear", "trench")];
    const boxes = (items: CollageItem[]) => layoutCollage(items).placed.map((p) => [p.slot, p.box]);
    expect(boxes(womens)).toEqual(boxes(mens));
  });
});

describe("layoutCollage: things the API should never send", () => {
  it("keeps the first item per slot and reports the rest as unplaced", () => {
    const layout = layoutCollage([TOP, BOTTOM, SHOES, item("shoes", "second-shoes")]);
    expect(layout.placed.map((p) => p.id)).toEqual(["bottom", "top", "shoes"]);
    expect(layout.unplaced.map((i) => i.id)).toEqual(["second-shoes"]);
  });

  it("a dress wins over separates", () => {
    const layout = layoutCollage([TOP, DRESS, BOTTOM, SHOES]);
    expect(layout.shape).toBe("one_piece");
    expect(layout.unplaced.map((i) => i.id)).toEqual(["top", "bottom"]);
  });

  it("an empty outfit gives an empty layout", () => {
    expect(layoutCollage([])).toMatchObject({ placed: [], unplaced: [], hasOuterwear: false });
  });
});

describe("layoutCollage: size", () => {
  it("defaults to a 4:5 portrait canvas", () => {
    const layout = layoutCollage([TOP, BOTTOM, SHOES]);
    expect([layout.width, layout.height]).toEqual([COLLAGE_SIZE.width, COLLAGE_SIZE.height]);
    expect(layout.width / layout.height).toBeCloseTo(4 / 5);
  });

  it("scales every box with the canvas", () => {
    const big = layoutCollage(COMPOSITIONS["top + bottom + shoes + outerwear"]!, { width: 1000, height: 1250 });
    const small = layoutCollage(COMPOSITIONS["top + bottom + shoes + outerwear"]!, { width: 500, height: 625 });
    big.placed.forEach((p, i) => {
      const s = small.placed[i]!.box;
      expect(Math.abs(p.box.x / 2 - s.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(p.box.width / 2 - s.width)).toBeLessThanOrEqual(1);
    });
  });
});

describe("opaqueBounds", () => {
  /** A width x height RGBA image, transparent except for the given opaque pixels. */
  function image(width: number, height: number, opaque: [number, number][]) {
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (const [x, y] of opaque) rgba[(y * width + x) * 4 + 3] = 255;
    return rgba;
  }

  it("finds the item inside a transparent cut-out", () => {
    expect(opaqueBounds(image(10, 10, [[2, 3], [6, 8], [4, 5]]), 10, 10)).toEqual({ x: 2, y: 3, width: 5, height: 6 });
  });

  it("ignores near-transparent fringe pixels", () => {
    const rgba = image(4, 4, [[1, 1]]);
    rgba[(3 * 4 + 3) * 4 + 3] = 5; // a faint pixel at (3, 3)
    expect(opaqueBounds(rgba, 4, 4)).toEqual({ x: 1, y: 1, width: 1, height: 1 });
  });

  it("an ordinary photo (no transparency) keeps its whole frame", () => {
    const rgba = new Uint8ClampedArray(3 * 2 * 4).fill(255);
    expect(opaqueBounds(rgba, 3, 2)).toEqual({ x: 0, y: 0, width: 3, height: 2 });
  });

  it("returns null for a fully transparent image", () => {
    expect(opaqueBounds(image(5, 5, []), 5, 5)).toBeNull();
  });
});

describe("fitContain", () => {
  const box: Box = { x: 100, y: 200, width: 400, height: 400 };

  it("fits a tall image to the box height, centred across", () => {
    expect(fitContain(box, 200, 400)).toEqual({ x: 200, y: 200, width: 200, height: 400 });
  });

  it("fits a wide image to the box width, centred down", () => {
    expect(fitContain(box, 800, 400)).toEqual({ x: 100, y: 300, width: 400, height: 200 });
  });

  it("never scales a small image up more than 2x", () => {
    expect(fitContain(box, 50, 50)).toEqual({ x: 250, y: 350, width: 100, height: 100 });
  });

  it("falls back to the whole box when the image has no size (e.g. an SVG without one)", () => {
    expect(fitContain(box, 0, 0)).toEqual(box);
  });
});
