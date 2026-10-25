/**
 * Where each item goes in an outfit collage. Pure functions only (no DOM),
 * so the layout is unit-tested separately from the canvas drawing in
 * collage-draw.ts.
 *
 * The spec's fixed flat-lay: top or dress upper centre, bottom below, shoes
 * at the foot, outerwear to the side. Positions depend only on each item's
 * category, so menswear and womenswear lay out the same way.
 *
 *   No outerwear              With outerwear
 *   ┌────────────────┐        ┌────────────────┐
 *   │    [ top  ]    │        │  [ top  ][coat]│
 *   │    [bottom]    │        │  [bottom][    ]│
 *   │    [shoes ]    │        │  [shoes ]      │
 *   └────────────────┘        └────────────────┘
 *
 * With outerwear the body column moves left to make room, and the outerwear
 * is drawn first so the top overlaps its edge, like a real flat-lay. A dress
 * or jumpsuit takes the top and bottom slots as one tall box.
 */
import type { Category } from "@/contracts";

/** Canvas size in pixels: 4:5 portrait, sharp on a 3x phone screen at 360 px wide. */
export const COLLAGE_SIZE = { width: 1080, height: 1350 } as const;

export type CollageSlot = "upper" | "lower" | "feet" | "side";

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CollageItem {
  id: string;
  category: Category;
  /** Cut-out if there is one, otherwise the original (displayImageUrl). */
  imageUrl: string;
  /** Short text for placeholders and screen readers, e.g. the description. */
  label: string;
}

export interface PlacedItem extends CollageItem {
  slot: CollageSlot;
  /** The box the image is fitted into (see fitContain). */
  box: Box;
}

export interface CollageLayout {
  width: number;
  height: number;
  /** "one_piece" when a dress or jumpsuit fills the body. */
  shape: "separates" | "one_piece";
  hasOuterwear: boolean;
  /** In drawing order, back to front: outerwear, bottom, top or dress, shoes. */
  placed: PlacedItem[];
  /**
   * Items with nowhere to go, e.g. a second pair of shoes. The API never
   * returns outfits like that (checkComposition), so this is normally empty.
   */
  unplaced: CollageItem[];
}

/**
 * The layout as fractions of the canvas, so it scales to any size and is
 * easy to tweak. `cx` is the centre of the body column; boxes in that
 * column are centred on it.
 */
export const COLLAGE_GEOMETRY = {
  bodyCentreX: { alone: 0.5, withOuterwear: 0.4 },
  upper: { width: 0.5, top: 0.03, height: 0.36 },
  lower: { width: 0.44, top: 0.37, height: 0.41 },
  onePiece: { width: 0.54, top: 0.03, height: 0.75 },
  feet: { width: 0.38, top: 0.8, height: 0.17 },
  side: { left: 0.62, width: 0.36, top: 0.1, height: 0.54 },
} as const;

const SLOT_FOR_CATEGORY: Record<Category, CollageSlot> = {
  top: "upper",
  dress_jumpsuit: "upper",
  bottom: "lower",
  shoes: "feet",
  outerwear: "side",
};

/** Lay out an outfit's items. Keeps the first item for each slot. */
export function layoutCollage(
  items: readonly CollageItem[],
  size: { width: number; height: number } = COLLAGE_SIZE,
): CollageLayout {
  const { width: W, height: H } = size;
  const g = COLLAGE_GEOMETRY;

  // A dress or jumpsuit owns the whole body, so it wins over separates.
  const dress = items.find((i) => i.category === "dress_jumpsuit");
  const shape: CollageLayout["shape"] = dress ? "one_piece" : "separates";

  const chosen = new Map<CollageSlot, CollageItem>();
  const unplaced: CollageItem[] = [];
  if (dress) chosen.set("upper", dress);
  for (const item of items) {
    if (item === dress) continue;
    const slot = SLOT_FOR_CATEGORY[item.category];
    const blockedByDress = dress !== undefined && (item.category === "top" || item.category === "bottom");
    if (blockedByDress || chosen.has(slot)) {
      unplaced.push(item);
    } else {
      chosen.set(slot, item);
    }
  }

  const hasOuterwear = chosen.has("side");
  const cx = (hasOuterwear ? g.bodyCentreX.withOuterwear : g.bodyCentreX.alone) * W;

  const centred = (spec: { width: number; top: number; height: number }): Box => ({
    x: cx - (spec.width * W) / 2,
    y: spec.top * H,
    width: spec.width * W,
    height: spec.height * H,
  });

  const boxFor: Record<CollageSlot, Box> = {
    upper: centred(shape === "one_piece" ? g.onePiece : g.upper),
    lower: centred(g.lower),
    feet: centred(g.feet),
    side: { x: g.side.left * W, y: g.side.top * H, width: g.side.width * W, height: g.side.height * H },
  };

  const drawOrder: CollageSlot[] = ["side", "lower", "upper", "feet"];
  const placed = drawOrder.flatMap((slot): PlacedItem[] => {
    const item = chosen.get(slot);
    return item ? [{ ...item, slot, box: roundBox(boxFor[slot]) }] : [];
  });

  return { width: W, height: H, shape, hasOuterwear, placed, unplaced };
}

/**
 * The largest rectangle with the image's aspect ratio that fits inside `box`,
 * centred horizontally and sitting on the box's vertical centre. Like CSS
 * object-fit: contain. Images are never scaled up past 2x their natural size,
 * so a tiny thumbnail doesn't turn into a blurry blob.
 */
export function fitContain(box: Box, naturalWidth: number, naturalHeight: number): Box {
  if (naturalWidth <= 0 || naturalHeight <= 0) return { ...box };
  const scale = Math.min(box.width / naturalWidth, box.height / naturalHeight, 2);
  const width = naturalWidth * scale;
  const height = naturalHeight * scale;
  return roundBox({
    x: box.x + (box.width - width) / 2,
    y: box.y + (box.height - height) / 2,
    width,
    height,
  });
}

/**
 * The part of an image that isn't transparent, from its RGBA pixels (as
 * ImageData gives them). Cut-outs keep the photo's full frame with the item
 * somewhere inside it; trimming to these bounds lets the item fill its slot.
 * Returns null if every pixel is (nearly) transparent. A photo with no
 * transparency returns the whole image.
 */
export function opaqueBounds(rgba: ArrayLike<number>, width: number, height: number, minAlpha = 16): Box | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if ((rgba[(y * width + x) * 4 + 3] ?? 0) >= minAlpha) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

function roundBox(box: Box): Box {
  return {
    x: Math.round(box.x),
    y: Math.round(box.y),
    width: Math.round(box.width),
    height: Math.round(box.height),
  };
}
