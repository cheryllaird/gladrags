/**
 * Milestone 5 outfit UI: gaps in the collage (every composition, with gaps
 * in each slot), the gap copy, the cut-out queue, the shop search client
 * calls and error copy, and the "Include items from my shops" flag.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkComposition, type Category, type Outfit, type OutfitGap, type ShopProduct } from "@/contracts";
import { MOCK_ITEMS } from "@/lib/mocks/fixtures";
import { createOutfitsApi } from "./api";
import { drawCollage, fitGapText } from "./collage-draw";
import { layoutCollage, wrapText, type Box, type CollageItem, type CollageLayout } from "./collage-layout";
import { describeApiError } from "./copy";
import { CutoutQueue, needsCutout, type CutoutDeps } from "./cutout-queue";
import { addBoughtProductHref, collageDescription, gapToCollageItem, missingCategoriesMessage, shopName } from "./gap-copy";
import { EMPTY_DRAFT, draftToRequest } from "./request-draft";

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PRODUCT: ShopProduct = {
  shopId: "next",
  title: "White leather trainers",
  url: "https://www.next.co.uk/style/st123",
  priceText: "£35",
  imageUrl: "https://xcdn.next.co.uk/images/st123.jpg",
};

function gap(category: Category, overrides: Partial<OutfitGap> = {}): OutfitGap {
  return {
    category,
    subcategory: null,
    colours: ["white", "navy"],
    description: `Suggested ${category}`,
    shopResults: [],
    searchedAt: null,
    shopProduct: null,
    ...overrides,
  };
}

const owned = (category: Category, id: string = category): CollageItem => ({
  id,
  category,
  imageUrl: `/mock/items/${id}.svg`,
  label: id,
});
const gapItem = (category: Category, overrides: Partial<OutfitGap> = {}) => gapToCollageItem(gap(category, overrides));

const boxOf = (layout: CollageLayout, id: string): Box => {
  const placed = layout.placed.find((p) => p.id === id);
  if (!placed) throw new Error(`${id} wasn't placed`);
  return placed.box;
};

// ---------------------------------------------------------------------------
// Layout: a gap takes its slot exactly as an owned item would
// ---------------------------------------------------------------------------

/** Each composition, with each of its slots in turn as a gap (at least one owned item). */
const SHAPES: Record<string, Category[]> = {
  "top + bottom + shoes": ["top", "bottom", "shoes"],
  "top + bottom + shoes + outerwear": ["top", "bottom", "shoes", "outerwear"],
  "dress + shoes": ["dress_jumpsuit", "shoes"],
  "dress + shoes + outerwear": ["dress_jumpsuit", "shoes", "outerwear"],
};

describe("layoutCollage with gaps", () => {
  for (const [name, categories] of Object.entries(SHAPES)) {
    const allOwned = layoutCollage(categories.map((c) => owned(c)));
    for (const gapCategory of categories) {
      it(`${name}, with the ${gapCategory} as a gap: same boxes as the all-owned outfit`, () => {
        const items = categories.map((c) => (c === gapCategory ? gapItem(c) : owned(c)));
        expect(checkComposition(categories.filter((c) => c !== gapCategory), [gapCategory])).toEqual({ ok: true });
        const layout = layoutCollage(items);
        expect(layout.unplaced).toEqual([]);
        expect(layout.shape).toBe(allOwned.shape);
        expect(layout.hasOuterwear).toBe(allOwned.hasOuterwear);
        for (const c of categories) {
          const id = c === gapCategory ? `gap:${c}` : c;
          expect(boxOf(layout, id)).toEqual(boxOf(allOwned, c));
        }
        const placedGap = layout.placed.find((p) => p.gap);
        expect(placedGap?.imageUrl).toBeNull();
      });
    }
  }

  it("a single owned top with bottom and shoes gaps (a one-item wardrobe) lays out as separates", () => {
    const layout = layoutCollage([owned("top"), gapItem("bottom"), gapItem("shoes")]);
    expect(layout.shape).toBe("separates");
    expect(layout.placed.map((p) => p.id)).toEqual(["gap:bottom", "top", "gap:shoes"]);
  });

  it("an outerwear gap (a shop item) moves the body column aside like owned outerwear", () => {
    const layout = layoutCollage([owned("dress_jumpsuit", "dress"), owned("shoes"), gapItem("outerwear")]);
    expect(layout.hasOuterwear).toBe(true);
    expect(layout.placed[0]!.id).toBe("gap:outerwear");
  });
});

// ---------------------------------------------------------------------------
// Drawing gaps
// ---------------------------------------------------------------------------

function recordingContext() {
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
    arc: record("arc"),
    fill: record("fill"),
    stroke: record("stroke"),
    fillText: record("fillText"),
    setLineDash: record("setLineDash"),
    // About 15 px per character at the gap font: enough to make wrapping happen.
    measureText: (s: string) => ({ width: s.length * 15 }),
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
    font: "",
    textAlign: "",
    textBaseline: "",
    shadowColor: "",
    shadowBlur: 0,
    shadowOffsetY: 0,
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

function stubOpaqueScan() {
  vi.stubGlobal("document", {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({
        drawImage: () => {},
        getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4).fill(255) }),
      }),
    }),
  });
}

describe("drawCollage with gaps", () => {
  it("draws a gap as a dashed outline with its description and swatches, not as a failed picture", () => {
    stubOpaqueScan();
    const { ctx, calls } = recordingContext();
    const layout = layoutCollage([owned("top"), owned("bottom"), gapItem("shoes", { description: "White leather trainers" })]);
    const images = new Map([
      ["top", { naturalWidth: 100, naturalHeight: 100 }],
      ["bottom", { naturalWidth: 100, naturalHeight: 100 }],
    ]) as unknown as Map<string, HTMLImageElement>;

    const result = drawCollage(ctx, layout, images);

    expect(result.placeholders).toEqual([]);
    expect(calls.filter((c) => c.op === "drawImage")).toHaveLength(2);
    expect(calls.some((c) => c.op === "setLineDash" && (c.args[0] as number[]).length > 0)).toBe(true);
    expect(calls.filter((c) => c.op === "arc")).toHaveLength(2); // white and navy swatches
    const text = calls.filter((c) => c.op === "fillText").map((c) => c.args[0]);
    expect(text.join(" ")).toBe("White leather trainers");
    // The text sits inside the gap's slot.
    const shoes = boxOf(layout, "gap:shoes");
    for (const c of calls.filter((c) => c.op === "fillText")) {
      const [, x, y] = c.args as [string, number, number];
      expect(x).toBeGreaterThan(shoes.x);
      expect(x).toBeLessThan(shoes.x + shoes.width);
      expect(y).toBeGreaterThan(shoes.y);
      expect(y).toBeLessThan(shoes.y + shoes.height);
    }
  });

  it("a chosen shop product shows its name under the description, but never its picture", () => {
    stubOpaqueScan();
    const { ctx, calls } = recordingContext();
    const layout = layoutCollage([owned("dress_jumpsuit", "dress"), gapItem("shoes", { description: "Tan sandals", shopProduct: PRODUCT })]);
    drawCollage(ctx, layout, new Map([["dress", { naturalWidth: 50, naturalHeight: 50 }]]) as unknown as Map<string, HTMLImageElement>);
    const text = calls.filter((c) => c.op === "fillText").map((c) => c.args[0] as string);
    expect(text[0]).toBe("Tan sandals");
    expect(text.slice(1).join(" ")).toContain("White leather");
    // Only the dress is drawn as an image: the product picture stays off the canvas.
    expect(calls.filter((c) => c.op === "drawImage")).toHaveLength(1);
  });
});

describe("fitGapText", () => {
  const measure = (_font: string, text: string) => text.length * 15;
  const gapText = (description: string, productTitle: string | null) => ({ description, swatches: ["#fff"], productTitle });

  it("short text fits at full size with its swatches", () => {
    expect(fitGapText(gapText("White trainers", null), 200, 346, measure)).toMatchObject({
      lines: ["White trainers"],
      productLines: [],
      showSwatches: true,
      scale: 1,
    });
  });

  it("text too tall for the slot shrinks, then loses lines, and always fits the height", () => {
    const long = gapText("Chunky white leather trainers with a gum sole and padded collar", "Next Signature leather trainers in white");
    for (const height of [400, 200, 150, 100]) {
      const fit = fitGapText(long, height, 346, measure);
      const lineHeight = 38 * fit.scale;
      const total =
        (fit.showSwatches ? 52 : 0) + fit.lines.length * lineHeight + (fit.productLines.length ? 12 : 0) + fit.productLines.length * lineHeight;
      expect(total).toBeLessThanOrEqual(height);
      expect(fit.lines.length).toBeGreaterThanOrEqual(1);
      expect(fit.productLines.length).toBeGreaterThanOrEqual(1);
    }
    expect(fitGapText(long, 400, 346, measure).scale).toBe(1);
  });
});

describe("wrapText", () => {
  const measure = (s: string) => s.length;

  it("keeps short text on one line", () => {
    expect(wrapText("White trainers", 20, measure)).toEqual(["White trainers"]);
  });

  it("breaks between words to fit the width", () => {
    expect(wrapText("White leather trainers with gum soles", 15, measure)).toEqual(["White leather", "trainers with", "gum soles"]);
  });

  it("ends with an ellipsis when it needs more lines than allowed", () => {
    const lines = wrapText("one two three four five six seven eight", 9, measure, 2);
    expect(lines).toHaveLength(2);
    expect(lines[1]!.endsWith("…")).toBe(true);
    expect(measure(lines[1]!)).toBeLessThanOrEqual(9);
  });

  it("keeps an over-long single word whole rather than splitting it", () => {
    expect(wrapText("Supercalifragilistic", 5, measure)).toEqual(["Supercalifragilistic"]);
  });

  it("gives no lines for blank text", () => {
    expect(wrapText("   ", 10, measure)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Gap copy
// ---------------------------------------------------------------------------

describe("gap copy", () => {
  it("missing categories in friendly words, or nothing when nothing's missing", () => {
    expect(missingCategoriesMessage([])).toBeNull();
    expect(missingCategoriesMessage(["shoes"])).toBe("Add shoes to your wardrobe to complete these outfits.");
    expect(missingCategoriesMessage(["top", "bottom", "shoes"])).toBe(
      "Add tops, trousers or skirts and shoes to your wardrobe to complete these outfits.",
    );
  });

  it("gapToCollageItem: an id per slot, no picture, swatch colours, the chosen product's name", () => {
    const item = gapToCollageItem(gap("shoes", { colours: ["white"], description: "White trainers", shopProduct: PRODUCT }));
    expect(item).toMatchObject({ id: "gap:shoes", category: "shoes", imageUrl: null, label: "White trainers" });
    expect(item.gap).toEqual({ description: "White trainers", swatches: ["#ffffff"], productTitle: PRODUCT.title });
  });

  it("collageDescription names the suggestions as not in the wardrobe", () => {
    const shirt = MOCK_ITEMS[0]!;
    expect(collageDescription([shirt], [gap("shoes", { description: "White trainers" })])).toBe(
      `Collage of ${shirt.tags.description}, suggested White trainers (not in your wardrobe)`,
    );
    expect(collageDescription([shirt])).toBe(`Collage of ${shirt.tags.description}`);
  });

  it("I've bought this goes to add-by-link with the product page filled in", () => {
    expect(addBoughtProductHref(PRODUCT)).toBe(`/add/link?url=${encodeURIComponent(PRODUCT.url)}`);
    expect(shopName(PRODUCT)).toBe("Next");
  });
});

// ---------------------------------------------------------------------------
// Cut-out queue
// ---------------------------------------------------------------------------

const ITEM = { id: "item-1", originalUrl: "/o/1.jpg", cutoutUrl: null, needsPhoto: false };
const ITEM_2 = { id: "item-2", originalUrl: "/o/2.jpg", cutoutUrl: null, needsPhoto: false };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeDeps(overrides: Partial<CutoutDeps> = {}) {
  const deps = {
    fetchOriginal: vi.fn(async (url: string) => new Blob([url])),
    removeBackground: vi.fn(async (image: Blob) => new Blob([await image.text(), "-cut"], { type: "image/png" })),
    fitCutout: vi.fn(async (cutout: Blob) => cutout),
    upload: vi.fn(async () => true),
    toUrl: vi.fn((cutout: Blob) => `blob:${cutout.size}`),
    ...overrides,
  };
  return deps;
}

describe("CutoutQueue", () => {
  it("needsCutout: only items without a cut-out whose original is a real picture", () => {
    expect(needsCutout(ITEM)).toBe(true);
    expect(needsCutout({ ...ITEM, cutoutUrl: "/c/1.png" })).toBe(false);
    expect(needsCutout({ ...ITEM, needsPhoto: true })).toBe(false);
  });

  it("cuts out, uploads, and returns a URL to draw the cut-out from", async () => {
    const deps = fakeDeps();
    const queue = new CutoutQueue(() => deps);
    const result = await queue.request(ITEM);
    expect(result).toEqual({ url: expect.stringMatching(/^blob:/), uploaded: true });
    expect(deps.fetchOriginal).toHaveBeenCalledWith("/o/1.jpg");
    expect(deps.upload).toHaveBeenCalledWith("item-1", expect.any(Blob));
    expect(queue.peek("item-1")).toEqual(result);
  });

  it("does each item once per session, however many collages ask", async () => {
    const deps = fakeDeps();
    const queue = new CutoutQueue(() => deps);
    const [a, b] = await Promise.all([queue.request(ITEM), queue.request(ITEM)]);
    const c = await queue.request(ITEM);
    expect(a).toBe(b);
    expect(c).toBe(a);
    expect(deps.removeBackground).toHaveBeenCalledTimes(1);
    expect(deps.upload).toHaveBeenCalledTimes(1);
  });

  it("runs one item at a time: the second waits for the first to finish", async () => {
    const first = deferred<Blob>();
    const deps = fakeDeps({ removeBackground: vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(new Blob(["x"])) });
    const queue = new CutoutQueue(() => deps);
    const one = queue.request(ITEM);
    const two = queue.request(ITEM_2);
    await new Promise((r) => setTimeout(r, 0));
    expect(deps.fetchOriginal).toHaveBeenCalledTimes(1);
    expect(deps.removeBackground).toHaveBeenCalledTimes(1);
    first.resolve(new Blob(["one"]));
    await one;
    await two;
    expect(deps.removeBackground).toHaveBeenCalledTimes(2);
  });

  it("creates the remover only when the first cut-out is needed", async () => {
    const makeDeps = vi.fn(() => fakeDeps());
    const queue = new CutoutQueue(makeDeps);
    expect(makeDeps).not.toHaveBeenCalled();
    await queue.request(ITEM);
    await queue.request(ITEM_2);
    expect(makeDeps).toHaveBeenCalledTimes(1);
  });

  it("a removal failure falls back to the original and isn't retried this session", async () => {
    const deps = fakeDeps({ removeBackground: vi.fn(async () => Promise.reject(new Error("out of memory"))) });
    const queue = new CutoutQueue(() => deps);
    expect(await queue.request(ITEM)).toEqual({ url: null, uploaded: false });
    expect(await queue.request(ITEM)).toEqual({ url: null, uploaded: false });
    expect(deps.removeBackground).toHaveBeenCalledTimes(1);
    expect(deps.upload).not.toHaveBeenCalled();
  });

  it("a cut-out too big to fit the limits isn't uploaded", async () => {
    const deps = fakeDeps({ fitCutout: vi.fn(async () => null) });
    const queue = new CutoutQueue(() => deps);
    expect(await queue.request(ITEM)).toEqual({ url: null, uploaded: false });
    expect(deps.upload).not.toHaveBeenCalled();
  });

  it("an original that won't download can be tried again later (e.g. with a fresh signed URL)", async () => {
    const deps = fakeDeps({
      fetchOriginal: vi.fn().mockRejectedValueOnce(new Error("403")).mockResolvedValue(new Blob(["ok"])),
    });
    const queue = new CutoutQueue(() => deps);
    expect(await queue.request(ITEM)).toEqual({ url: null, uploaded: false });
    expect(queue.peek(ITEM.id)).toBeUndefined();
    expect((await queue.request(ITEM)).url).not.toBeNull();
  });

  it("a failed upload still draws the cut-out made here", async () => {
    const deps = fakeDeps({ upload: vi.fn(async () => Promise.reject(new Error("offline"))) });
    const queue = new CutoutQueue(() => deps);
    expect(await queue.request(ITEM)).toEqual({ url: expect.stringMatching(/^blob:/), uploaded: false });
  });

  it("a remover that hangs counts as failed after the timeout, and the next item still runs", async () => {
    const deps = fakeDeps({
      removeBackground: vi.fn().mockReturnValueOnce(new Promise<Blob>(() => {})).mockResolvedValue(new Blob(["two"])),
    });
    const queue = new CutoutQueue(() => deps, { removalTimeoutMs: 20 });
    const [one, two] = await Promise.all([queue.request(ITEM), queue.request(ITEM_2)]);
    expect(one).toEqual({ url: null, uploaded: false });
    expect(two.url).not.toBeNull();
    expect(deps.upload).toHaveBeenCalledTimes(1);
  });

  it("keeps only the latest results, freeing the older cut-outs' URLs; a freed item isn't cut out again", async () => {
    const revokeUrl = vi.fn();
    let n = 0;
    const deps = fakeDeps({ revokeUrl, toUrl: vi.fn(() => `blob:${++n}`) });
    const queue = new CutoutQueue(() => deps, { maxKept: 2 });
    const item = (id: string) => ({ ...ITEM, id });
    await queue.request(item("a"));
    await queue.request(item("b"));
    await queue.request(item("c"));
    expect(revokeUrl).toHaveBeenCalledWith("blob:1");
    expect(queue.peek("a")).toBeUndefined();
    expect(queue.peek("c")).toEqual({ url: "blob:3", uploaded: true });
    expect(await queue.request(item("a"))).toEqual({ url: null, uploaded: false });
    expect(deps.removeBackground).toHaveBeenCalledTimes(3);
  });

  it("skips a queued job whose collage went away, and a later collage can queue it again", async () => {
    const first = deferred<Blob>();
    const deps = fakeDeps({ removeBackground: vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(new Blob(["x"])) });
    const queue = new CutoutQueue(() => deps);
    void queue.request(ITEM);
    const gone = new AbortController();
    const skipped = queue.request(ITEM_2, gone.signal);
    gone.abort();
    first.resolve(new Blob(["one"]));
    expect(await skipped).toEqual({ url: null, uploaded: false });
    expect(deps.fetchOriginal).toHaveBeenCalledTimes(1);
    expect(queue.peek(ITEM_2.id)).toBeUndefined();
    expect((await queue.request(ITEM_2)).url).not.toBeNull();
  });

  it("doesn't skip a job another collage still wants", async () => {
    const first = deferred<Blob>();
    const deps = fakeDeps({ removeBackground: vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(new Blob(["x"])) });
    const queue = new CutoutQueue(() => deps);
    void queue.request(ITEM);
    const gone = new AbortController();
    const still = new AbortController();
    void queue.request(ITEM_2, gone.signal);
    const wanted = queue.request(ITEM_2, still.signal);
    gone.abort();
    first.resolve(new Blob(["one"]));
    expect((await wanted).url).not.toBeNull();
  });

  it("a failure on one item doesn't stop the next", async () => {
    const deps = fakeDeps({
      removeBackground: vi.fn().mockRejectedValueOnce(new Error("no subject")).mockResolvedValue(new Blob(["two"])),
    });
    const queue = new CutoutQueue(() => deps);
    const [one, two] = await Promise.all([queue.request(ITEM), queue.request(ITEM_2)]);
    expect(one.url).toBeNull();
    expect(two.url).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// API client: shop search, picking a product, uploading a cut-out
// ---------------------------------------------------------------------------

const shirt = MOCK_ITEMS[0]!;
const jeans = MOCK_ITEMS[3]!;
const GAP_OUTFIT: Outfit = {
  id: "2b000000-0000-4000-8000-000000000009",
  request: { style: { kind: "preset", presetId: "casual" }, guidance: null, anchorItemId: null, includeShopItems: true },
  name: "Easy weekend",
  reason: "White trainers keep this crisp",
  itemIds: [shirt.id, jeans.id],
  items: [shirt, jeans],
  gaps: [gap("shoes", { shopResults: [PRODUCT], searchedAt: "2026-10-31T10:00:00.000Z" })],
  status: "suggested",
  parentOutfitId: null,
  createdAt: "2026-10-31T10:00:00.000Z",
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("outfits API client (milestone 5)", () => {
  it("findInShops posts to the outfit's shop-search route and returns the outfit with results", async () => {
    const fetchImpl = vi.fn(async (_input: string, _init?: RequestInit) => json(200, { outfit: GAP_OUTFIT }));
    const result = await createOutfitsApi(fetchImpl).findInShops(GAP_OUTFIT.id);
    expect(result.ok && result.data.outfit.gaps[0]!.shopResults).toEqual([PRODUCT]);
    expect(fetchImpl.mock.calls[0]![0]).toBe(`/api/outfits/${GAP_OUTFIT.id}/shop-search`);
    expect(fetchImpl.mock.calls[0]![1]?.method).toBe("POST");
  });

  it("findInShops passes the shop search cap through as an error", async () => {
    const cap = { kind: "shop_searches_per_day", limit: 10, resetsAt: "2026-11-01T00:00:00.000Z" };
    const fetchImpl = vi.fn(async () => json(429, { error: { code: "daily_cap_reached", message: "Limit", cap } }));
    const result = await createOutfitsApi(fetchImpl).findInShops(GAP_OUTFIT.id);
    expect(result).toEqual({ ok: false, error: { code: "daily_cap_reached", message: "Limit", cap } });
  });

  it("chooseGapProduct PUTs the product link to the gap's slot, or null to clear", async () => {
    const fetchImpl = vi.fn(async (_input: string, _init?: RequestInit) => json(200, { outfit: GAP_OUTFIT }));
    const api = createOutfitsApi(fetchImpl);
    await api.chooseGapProduct(GAP_OUTFIT.id, "shoes", PRODUCT.url);
    await api.chooseGapProduct(GAP_OUTFIT.id, "shoes", null);
    expect(fetchImpl.mock.calls[0]![0]).toBe(`/api/outfits/${GAP_OUTFIT.id}/gaps/shoes`);
    expect(fetchImpl.mock.calls[0]![1]?.method).toBe("PUT");
    expect(JSON.parse(fetchImpl.mock.calls[0]![1]?.body as string)).toEqual({ productUrl: PRODUCT.url });
    expect(JSON.parse(fetchImpl.mock.calls[1]![1]?.body as string)).toEqual({ productUrl: null });
  });

  it("chooseGapProduct refuses a link that isn't a web address before sending", async () => {
    const fetchImpl = vi.fn(async () => json(200, {}));
    const result = await createOutfitsApi(fetchImpl).chooseGapProduct(GAP_OUTFIT.id, "shoes", "javascript:alert(1)");
    expect(result.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("uploadCutout sends the PNG as multipart field `cutout`, without a JSON content type", async () => {
    const fetchImpl = vi.fn(async (_input: string, _init?: RequestInit) => json(200, { item: shirt }));
    const result = await createOutfitsApi(fetchImpl).uploadCutout(shirt.id, new Blob(["png"], { type: "image/png" }));
    expect(result.ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`/api/items/${shirt.id}/cutout`);
    expect(init?.method).toBe("PUT");
    expect(init?.body).toBeInstanceOf(FormData);
    expect((init?.body as FormData).get("cutout")).toBeInstanceOf(Blob);
    expect((init?.headers as Record<string, string>)["content-type"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Error copy for shop search, and the request flag
// ---------------------------------------------------------------------------

describe("shop search error copy", () => {
  it("the daily cap names shop searches, not outfit requests", () => {
    const copy = describeApiError(
      {
        code: "daily_cap_reached",
        message: "x",
        cap: { kind: "shop_searches_per_day", limit: 10, resetsAt: "2026-11-01T00:00:00.000Z" },
      },
      "shop_search",
    );
    expect(copy.title).toBe("That's today's shop searches used up");
    expect(copy.message).toContain("10 shop searches");
    expect(copy.retryable).toBe(false);
  });

  it("ai_paused says shop search is paused and outfits still work", () => {
    const copy = describeApiError({ code: "ai_paused", message: "x" }, "shop_search");
    expect(copy.title).toBe("Shop search is paused for now");
    expect(copy.message).toContain("until next month");
  });

  it("other errors read as before", () => {
    expect(describeApiError({ code: "internal", message: "Oops" }, "shop_search")).toEqual(
      describeApiError({ code: "internal", message: "Oops" }),
    );
  });
});

describe("draftToRequest: Include items from my shops", () => {
  it("sends includeShopItems: true when the toggle is on", () => {
    const result = draftToRequest({ ...EMPTY_DRAFT, style: "casual", includeShopItems: true }, null);
    expect(result).toMatchObject({ ok: true, request: { includeShopItems: true } });
  });

  it("leaves it out when off (the contract reads that as false)", () => {
    const result = draftToRequest({ ...EMPTY_DRAFT, style: "casual" }, null);
    expect(result.ok && "includeShopItems" in result.request).toBe(false);
  });
});
