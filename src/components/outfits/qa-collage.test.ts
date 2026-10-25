// QA gap tests for the collage: layout edge cases, and the canvas drawing
// and export code in collage-draw.ts, run against small fakes (the unit
// tests run in Node, with no DOM or real canvas).
import { afterEach, describe, expect, it, vi } from "vitest";
import { displayImageUrl, type Category } from "@/contracts";
import { MOCK_ITEMS } from "@/lib/mocks/fixtures";
import { collageFileName, drawCollage, loadImage, saveCanvasAsImage } from "./collage-draw";
import { COLLAGE_SIZE, fitContain, layoutCollage, opaqueBounds, type Box, type CollageItem } from "./collage-layout";

const item = (category: Category, id: string = category): CollageItem => ({
  id,
  category,
  imageUrl: `/x/${id}.png`,
  label: id,
});

const inside = (inner: Box, outer: Box) =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.width <= outer.x + outer.width &&
  inner.y + inner.height <= outer.y + outer.height;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("layoutCollage: edge cases", () => {
  it("doesn't depend on the order the API lists items in", () => {
    const ordered = layoutCollage([item("top"), item("bottom"), item("shoes"), item("outerwear")]);
    const shuffled = layoutCollage([item("shoes"), item("outerwear"), item("bottom"), item("top")]);
    expect(shuffled.placed).toEqual(ordered.placed);
  });

  it("a dress listed after separates still owns the body; the separates are unplaced", () => {
    const layout = layoutCollage([item("top"), item("bottom"), item("dress_jumpsuit", "dress"), item("shoes")]);
    expect(layout.shape).toBe("one_piece");
    expect(layout.placed.map((p) => p.id)).toEqual(["dress", "shoes"]);
    expect(layout.unplaced.map((i) => i.id)).toEqual(["top", "bottom"]);
  });

  it("an outfit with only outerwear and shoes still lays out without throwing", () => {
    const layout = layoutCollage([item("outerwear"), item("shoes")]);
    expect(layout.placed.map((p) => p.slot)).toEqual(["side", "feet"]);
    expect(layout.hasOuterwear).toBe(true);
  });

  it("keeps the body column and outerwear inside a square or a tiny canvas", () => {
    for (const size of [{ width: 500, height: 500 }, { width: 10, height: 12 }]) {
      const layout = layoutCollage([item("top"), item("bottom"), item("shoes"), item("outerwear")], size);
      for (const { box } of layout.placed) {
        expect(inside(box, { x: 0, y: 0, ...size })).toBe(true);
      }
    }
  });

  it("outerwear doesn't cover the shoes", () => {
    const layout = layoutCollage([item("top"), item("bottom"), item("shoes"), item("outerwear")]);
    const side = layout.placed.find((p) => p.slot === "side")!.box;
    const feet = layout.placed.find((p) => p.slot === "feet")!.box;
    expect(side.y + side.height).toBeLessThanOrEqual(feet.y);
  });
});

describe("fitContain: extreme images stay inside their slot", () => {
  const layout = layoutCollage([item("top"), item("bottom"), item("shoes"), item("outerwear")]);
  const shapes: [string, number, number][] = [
    ["very tall (50 x 4000)", 50, 4000],
    ["very wide (4000 x 50)", 4000, 50],
    ["1 x 1 pixel", 1, 1],
    ["one pixel wide (1 x 1600)", 1, 1600],
    ["huge (1600 x 1600)", 1600, 1600],
  ];
  for (const [name, w, h] of shapes) {
    it(`${name}`, () => {
      for (const { box } of layout.placed) {
        const fitted = fitContain(box, w, h);
        expect(inside(fitted, box)).toBe(true);
        // Aspect ratio kept (within rounding), unless rounding a sliver to 0.
        if (fitted.width > 4 && fitted.height > 4) {
          expect(Math.abs(fitted.width / fitted.height - w / h) / (w / h)).toBeLessThan(0.1);
        }
      }
    });
  }

  it("negative sizes are treated like an unknown size", () => {
    const box = { x: 0, y: 0, width: 100, height: 100 };
    expect(fitContain(box, -10, 50)).toEqual(box);
  });
});

describe("opaqueBounds: edges", () => {
  it("counts alpha exactly at the threshold (16) as visible, and 15 as not", () => {
    const rgba = new Uint8ClampedArray(2 * 1 * 4);
    rgba[3] = 15;
    rgba[7] = 16;
    expect(opaqueBounds(rgba, 2, 1)).toEqual({ x: 1, y: 0, width: 1, height: 1 });
  });

  it("finds a single opaque pixel in the bottom-right corner", () => {
    const rgba = new Uint8ClampedArray(3 * 3 * 4);
    rgba[(2 * 3 + 2) * 4 + 3] = 255;
    expect(opaqueBounds(rgba, 3, 3)).toEqual({ x: 2, y: 2, width: 1, height: 1 });
  });

  it("a zero-sized image has no visible area", () => {
    expect(opaqueBounds(new Uint8ClampedArray(0), 0, 0)).toBeNull();
  });

  it("a short buffer (fewer pixels than claimed) doesn't throw", () => {
    expect(opaqueBounds(new Uint8ClampedArray(4).fill(255), 4, 4)).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });
});

describe("null cut-outs fall back to the original", () => {
  it("the camel coat fixture has no cut-out, and the collage uses its original", () => {
    const coat = MOCK_ITEMS.find((i) => i.tags.description.toLowerCase().includes("camel"))!;
    expect(coat.cutoutUrl).toBeNull();
    expect(displayImageUrl(coat)).toBe(coat.originalUrl);
  });

  it("prefers the cut-out when there is one", () => {
    expect(displayImageUrl({ cutoutUrl: "/c.png", originalUrl: "/o.jpg" })).toBe("/c.png");
  });
});

// ---------------------------------------------------------------------------
// Canvas drawing, with fakes
// ---------------------------------------------------------------------------

interface FakeImage {
  naturalWidth: number;
  naturalHeight: number;
}

/** A recording 2D context. */
function fakeContext() {
  const calls: { op: string; args: unknown[] }[] = [];
  const record =
    (op: string) =>
    (...args: unknown[]) => {
      calls.push({ op, args });
    };
  const ctx = {
    save: record("save"),
    restore: record("restore"),
    clearRect: record("clearRect"),
    fillRect: record("fillRect"),
    drawImage: record("drawImage"),
    beginPath: record("beginPath"),
    roundRect: record("roundRect"),
    fill: record("fill"),
    fillText: record("fillText"),
    fillStyle: "",
    font: "",
    textAlign: "",
    textBaseline: "",
    shadowColor: "",
    shadowBlur: 0,
    shadowOffsetY: 0,
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

/**
 * Stub document.createElement("canvas") for the transparency scan. `alpha`
 * gives each scanned pixel's alpha, in scan-canvas coordinates.
 */
function stubScanCanvas(alpha: (x: number, y: number, w: number, h: number) => number | "throw") {
  const scans: { width: number; height: number }[] = [];
  vi.stubGlobal("document", {
    createElement: (tag: string) => {
      if (tag !== "canvas") throw new Error(`unexpected element ${tag}`);
      const canvas = {
        width: 0,
        height: 0,
        getContext: () => ({
          drawImage: () => {},
          getImageData: (_x: number, _y: number, w: number, h: number) => {
            scans.push({ width: w, height: h });
            const data = new Uint8ClampedArray(w * h * 4);
            for (let y = 0; y < h; y++) {
              for (let x = 0; x < w; x++) {
                const a = alpha(x, y, w, h);
                if (a === "throw") throw new DOMException("The canvas has been tainted", "SecurityError");
                data[(y * w + x) * 4 + 3] = a;
              }
            }
            return { data, width: w, height: h };
          },
        }),
      };
      return canvas;
    },
  });
  return scans;
}

function drawnImages(calls: { op: string; args: unknown[] }[]) {
  return calls
    .filter((c) => c.op === "drawImage")
    .map((c) => {
      const [img, sx, sy, sw, sh, dx, dy, dw, dh] = c.args as [FakeImage, ...number[]];
      return { img, source: { x: sx!, y: sy!, width: sw!, height: sh! }, dest: { x: dx!, y: dy!, width: dw!, height: dh! } };
    });
}

describe("drawCollage", () => {
  const items = [item("top"), item("bottom"), item("shoes"), item("outerwear")];
  const layout = layoutCollage(items);

  it("fills the background, then draws every loaded image inside its slot, back to front", () => {
    stubScanCanvas(() => 255);
    const { ctx, calls } = fakeContext();
    const images = new Map(items.map((i) => [i.id, { naturalWidth: 800, naturalHeight: 1000 } as FakeImage]));
    drawCollage(ctx, layout, images as unknown as Map<string, HTMLImageElement>);

    expect(calls.find((c) => c.op === "fillRect")?.args).toEqual([0, 0, COLLAGE_SIZE.width, COLLAGE_SIZE.height]);
    const drawn = drawnImages(calls);
    expect(drawn).toHaveLength(4);
    drawn.forEach((d, i) => {
      expect(inside(d.dest, layout.placed[i]!.box)).toBe(true);
      // No transparency: the whole image is the source.
      expect(d.source).toEqual({ x: 0, y: 0, width: 800, height: 1000 });
    });
  });

  it("trims a cut-out's transparent margin so the item fills its slot", () => {
    // A 1000 x 1000 cut-out whose item sits in the middle 50%.
    stubScanCanvas((x, y, w, h) => (x >= w / 4 && x < (3 * w) / 4 && y >= h / 4 && y < (3 * h) / 4 ? 255 : 0));
    const { ctx, calls } = fakeContext();
    const single = layoutCollage([item("top")]);
    drawCollage(ctx, single, new Map([["top", { naturalWidth: 1000, naturalHeight: 1000 }]]) as unknown as Map<string, HTMLImageElement>);
    const [d] = drawnImages(calls);
    // The source rect hugs the item (with a pixel or so of slack).
    expect(d!.source.x).toBeGreaterThanOrEqual(240);
    expect(d!.source.x).toBeLessThanOrEqual(250);
    expect(d!.source.width).toBeGreaterThanOrEqual(500);
    expect(d!.source.width).toBeLessThanOrEqual(520);
    expect(d!.source.x + d!.source.width).toBeLessThanOrEqual(1000);
  });

  it("scans very tall and very wide images at a small size, and keeps the source rect inside the image", () => {
    for (const [w, h] of [
      [60, 4000],
      [4000, 60],
      [5000, 1],
    ] as const) {
      const scans = stubScanCanvas(() => 255);
      const { ctx, calls } = fakeContext();
      const single = layoutCollage([item("top")]);
      drawCollage(ctx, single, new Map([["top", { naturalWidth: w, naturalHeight: h }]]) as unknown as Map<string, HTMLImageElement>);
      expect(Math.max(scans[0]!.width, scans[0]!.height)).toBeLessThanOrEqual(256);
      expect(Math.min(scans[0]!.width, scans[0]!.height)).toBeGreaterThanOrEqual(1);
      const [d] = drawnImages(calls);
      expect(d!.source.x).toBeGreaterThanOrEqual(0);
      expect(d!.source.y).toBeGreaterThanOrEqual(0);
      expect(d!.source.x + d!.source.width).toBeLessThanOrEqual(w);
      expect(d!.source.y + d!.source.height).toBeLessThanOrEqual(h);
      expect(inside(d!.dest, single.placed[0]!.box)).toBe(true);
    }
  });

  it("draws the whole image when its pixels can't be read (a tainted canvas)", () => {
    stubScanCanvas(() => "throw");
    const { ctx, calls } = fakeContext();
    const single = layoutCollage([item("shoes")]);
    drawCollage(ctx, single, new Map([["shoes", { naturalWidth: 300, naturalHeight: 200 }]]) as unknown as Map<string, HTMLImageElement>);
    expect(drawnImages(calls)[0]!.source).toEqual({ x: 0, y: 0, width: 300, height: 200 });
  });

  it("an image with no natural size (an SVG without one) is drawn into the whole box without scanning", () => {
    const scans = stubScanCanvas(() => 255);
    const { ctx, calls } = fakeContext();
    const single = layoutCollage([item("top")]);
    drawCollage(ctx, single, new Map([["top", { naturalWidth: 0, naturalHeight: 0 }]]) as unknown as Map<string, HTMLImageElement>);
    expect(scans).toHaveLength(0);
    expect(drawnImages(calls)[0]!.dest).toEqual(single.placed[0]!.box);
  });

  it("an item whose image didn't load gets a labelled placeholder", () => {
    stubScanCanvas(() => 255);
    const { ctx, calls } = fakeContext();
    const images = new Map([["top", { naturalWidth: 10, naturalHeight: 10 }]]);
    drawCollage(ctx, layoutCollage([item("top"), item("bottom", "Blue jeans"), item("shoes")]), images as unknown as Map<string, HTMLImageElement>);
    expect(drawnImages(calls)).toHaveLength(1);
    const labels = calls.filter((c) => c.op === "fillText").map((c) => c.args[0]);
    expect(labels).toEqual(["Blue jeans", "shoes"]);
  });

  // FINDING (low): a fully transparent cut-out (background removal that
  // "succeeded" but kept nothing) is drawn as an invisible image, so its slot
  // looks empty with no placeholder and no "couldn't load" message. It
  // should be treated like a failed load (placeholder) or fall back to the
  // original. Pinned with it.fails until that's decided.
  it.fails("a fully transparent cut-out is not drawn as an invisible image", () => {
    stubScanCanvas(() => 0);
    const { ctx, calls } = fakeContext();
    const single = layoutCollage([item("top", "Grey jumper")]);
    drawCollage(ctx, single, new Map([["Grey jumper", { naturalWidth: 400, naturalHeight: 400 }]]) as unknown as Map<string, HTMLImageElement>);
    expect(drawnImages(calls)).toHaveLength(0);
    expect(calls.some((c) => c.op === "fillText" && c.args[0] === "Grey jumper")).toBe(true);
  });
});

describe("loadImage", () => {
  class FakeImageElement {
    static created: FakeImageElement[] = [];
    crossOrigin: string | null = null;
    decoding = "";
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    /** crossOrigin as it was when src was set: it must be set first. */
    crossOriginAtSrc: string | null | undefined;
    #src = "";
    constructor() {
      FakeImageElement.created.push(this);
    }
    set src(value: string) {
      this.crossOriginAtSrc = this.crossOrigin;
      this.#src = value;
    }
    get src() {
      return this.#src;
    }
  }

  it("asks for CORS (crossOrigin=anonymous) before setting src, so the canvas can be exported", async () => {
    FakeImageElement.created = [];
    vi.stubGlobal("Image", FakeImageElement);
    const loading = loadImage("https://project.supabase.co/storage/v1/object/sign/cutouts/a.png?token=x");
    const img = FakeImageElement.created[0]!;
    expect(img.crossOriginAtSrc).toBe("anonymous");
    expect(img.src).toContain("/cutouts/a.png");
    img.onload?.();
    await expect(loading).resolves.toBe(img);
  });

  it("rejects when the image fails to load (e.g. no CORS headers, expired signed URL)", async () => {
    FakeImageElement.created = [];
    vi.stubGlobal("Image", FakeImageElement);
    const loading = loadImage("/gone.png");
    FakeImageElement.created[0]!.onerror?.();
    await expect(loading).rejects.toThrow(/gone\.png/);
  });
});

describe("saveCanvasAsImage", () => {
  function fakeCanvas(blob: Blob | null) {
    return { toBlob: (cb: (b: Blob | null) => void) => cb(blob) } as unknown as HTMLCanvasElement;
  }

  function stubDownload() {
    const clicked: { href: string; download: string }[] = [];
    vi.stubGlobal("document", {
      createElement: () => {
        const link = {
          href: "",
          download: "",
          click: () => clicked.push({ href: link.href, download: link.download }),
          remove: () => {},
        };
        return link;
      },
      body: { append: () => {} },
    });
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:collage", revokeObjectURL: () => {} }));
    vi.useFakeTimers();
    return clicked;
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("throws when the canvas can't be exported (toBlob gives null, e.g. a tainted canvas)", async () => {
    await expect(saveCanvasAsImage(fakeCanvas(null), "Easy weekend")).rejects.toThrow();
  });

  it("downloads a PNG named after the outfit when the share sheet isn't available", async () => {
    const clicked = stubDownload();
    vi.stubGlobal("navigator", {});
    await expect(saveCanvasAsImage(fakeCanvas(new Blob(["png"], { type: "image/png" })), "Easy weekend")).resolves.toBe(
      "downloaded",
    );
    expect(clicked).toEqual([{ href: "blob:collage", download: "gladrags-easy-weekend.png" }]);
  });

  it("uses the share sheet when files can be shared", async () => {
    const share = vi.fn(async () => {});
    vi.stubGlobal("navigator", { canShare: () => true, share });
    await expect(saveCanvasAsImage(fakeCanvas(new Blob(["png"])), "Date night")).resolves.toBe("shared");
    expect(share).toHaveBeenCalledOnce();
  });

  it("closing the share sheet is 'cancelled', not an error, and doesn't download", async () => {
    const clicked = stubDownload();
    vi.stubGlobal("navigator", {
      canShare: () => true,
      share: async () => {
        throw new DOMException("Share canceled", "AbortError");
      },
    });
    await expect(saveCanvasAsImage(fakeCanvas(new Blob(["png"])), "Date night")).resolves.toBe("cancelled");
    expect(clicked).toEqual([]);
  });

  it("falls back to a download when sharing is refused for another reason", async () => {
    const clicked = stubDownload();
    vi.stubGlobal("navigator", {
      canShare: () => true,
      share: async () => {
        throw new DOMException("Not allowed", "NotAllowedError");
      },
    });
    await expect(saveCanvasAsImage(fakeCanvas(new Blob(["png"])), "Date night")).resolves.toBe("downloaded");
    expect(clicked).toHaveLength(1);
  });
});

describe("collageFileName: awkward names", () => {
  it.each([
    ["", "gladrags-outfit.png"],
    ["!!!", "gladrags-outfit.png"],
    ["Café crème", "gladrags-caf-cr-me.png"],
    ["A".repeat(60), `gladrags-${"a".repeat(40)}.png`],
    ["../../etc/passwd", "gladrags-etc-passwd.png"],
  ])("%j -> %s", (name, expected) => {
    expect(collageFileName(name)).toBe(expected);
  });
});
