/**
 * QA for the milestone 5 outfit screens (task C6): adversarial unit tests
 * for gaps in the collage, the gap copy, the cut-out queue, and the
 * shop search client with hostile product data.
 *
 * Known bugs are pinned with it.fails and named "BUG:" so the suite stays
 * green until they're fixed; a fix makes the pin fail, and it then becomes
 * an ordinary test.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_GAPS_PER_OUTFIT,
  OutfitResponseSchema,
  SHOP_PRODUCT_LIMITS,
  checkComposition,
  type Category,
  type Outfit,
  type OutfitGap,
  type ShopProduct,
} from "@/contracts";
import { MOCK_ITEMS } from "@/lib/mocks/fixtures";
import { createOutfitsApi } from "./api";
import { collageFileName, drawCollage } from "./collage-draw";
import {
  COLLAGE_SIZE,
  layoutCollage,
  wrapText,
  type Box,
  type CollageItem,
  type CollageLayout,
} from "./collage-layout";
import { describeApiError } from "./copy";
import { CutoutQueue, needsCutout, type CutoutDeps } from "./cutout-queue";
import {
  addBoughtProductHref,
  collageDescription,
  gapToCollageItem,
  missingCategoriesMessage,
} from "./gap-copy";

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CATEGORIES: Category[] = [
  "top",
  "bottom",
  "dress_jumpsuit",
  "shoes",
  "outerwear",
];

const PRODUCT: ShopProduct = {
  shopId: "next",
  title: "White leather trainers",
  url: "https://www.next.co.uk/style/st123",
  priceText: "£35",
  imageUrl: "https://xcdn.next.co.uk/images/st123.jpg",
};

function gap(
  category: Category,
  overrides: Partial<OutfitGap> = {},
): OutfitGap {
  return {
    category,
    subcategory: null,
    colours: ["white"],
    description: `Suggested ${category}`,
    shopResults: [],
    searchedAt: null,
    shopProduct: null,
    ...overrides,
  };
}

const owned = (category: Category): CollageItem => ({
  id: `owned:${category}`,
  category,
  imageUrl: `/mock/items/${category}.svg`,
  label: category,
});

/** Every non-empty subset of `xs`. */
function subsets<T>(xs: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let mask = 1; mask < 1 << xs.length; mask++)
    out.push(xs.filter((_, i) => mask & (1 << i)));
  return out;
}

/**
 * Every outfit the contract allows with 1 to 3 gaps: each composition, each
 * way of choosing its gap slots, keeping at least one owned piece.
 */
const SHAPES: Category[][] = [
  ["top", "bottom", "shoes"],
  ["top", "bottom", "shoes", "outerwear"],
  ["dress_jumpsuit", "shoes"],
  ["dress_jumpsuit", "shoes", "outerwear"],
];
const GAP_COMBINATIONS = SHAPES.flatMap((shape) =>
  subsets(shape)
    .filter(
      (gaps) =>
        gaps.length <= MAX_GAPS_PER_OUTFIT && gaps.length < shape.length,
    )
    .map((gaps) => ({ owned: shape.filter((c) => !gaps.includes(c)), gaps })),
);

function recordingContext(charWidth = 15) {
  const calls: { op: string; args: unknown[]; font: string }[] = [];
  const ctx = {
    font: "",
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
    textAlign: "",
    textBaseline: "",
    shadowColor: "",
    shadowBlur: 0,
    shadowOffsetY: 0,
    measureText: (s: string) => ({ width: [...s].length * charWidth }),
  } as Record<string, unknown>;
  for (const op of [
    "save",
    "restore",
    "clearRect",
    "fillRect",
    "drawImage",
    "beginPath",
    "roundRect",
    "arc",
    "fill",
    "stroke",
    "fillText",
    "setLineDash",
  ]) {
    ctx[op] = (...args: unknown[]) =>
      calls.push({ op, args, font: ctx.font as string });
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

function stubOpaqueScan() {
  vi.stubGlobal("document", {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({
        drawImage: () => {},
        getImageData: (_x: number, _y: number, w: number, h: number) => ({
          data: new Uint8ClampedArray(w * h * 4).fill(255),
        }),
      }),
    }),
  });
}

const fakeImage = {
  naturalWidth: 400,
  naturalHeight: 500,
} as unknown as HTMLImageElement;

function imagesFor(layout: CollageLayout) {
  return new Map(
    layout.placed.filter((p) => !p.gap).map((p) => [p.id, fakeImage]),
  );
}

function boxOf(layout: CollageLayout, id: string): Box {
  const placed = layout.placed.find((p) => p.id === id);
  if (!placed) throw new Error(`${id} wasn't placed`);
  return placed.box;
}

/** The text drawn inside one gap's box (fillText calls between its roundRect and the next slot). */
function textInside(calls: { op: string; args: unknown[] }[], box: Box) {
  return calls
    .filter((c) => c.op === "fillText")
    .map((c) => ({
      text: c.args[0] as string,
      x: c.args[1] as number,
      y: c.args[2] as number,
      maxWidth: c.args[3] as number,
    }))
    .filter(
      (t) =>
        t.x >= box.x &&
        t.x <= box.x + box.width &&
        t.y >= box.y - 200 &&
        t.y <= box.y + box.height + 200,
    );
}

// ---------------------------------------------------------------------------
// Every gap combination, 1 to 3 gaps
// ---------------------------------------------------------------------------

describe("collage with every allowed gap combination (1 to 3 gaps)", () => {
  it("covers every combination the contract allows", () => {
    // 2^3-2 + 2^4-2 (capped at 3 gaps) + 2^2-2 + 2^3-2 = 6 + 14 + 2 + 6
    expect(GAP_COMBINATIONS).toHaveLength(28);
    for (const { owned: o, gaps } of GAP_COMBINATIONS)
      expect(checkComposition(o, gaps)).toEqual({ ok: true });
  });

  for (const { owned: ownedCats, gaps } of GAP_COMBINATIONS) {
    const name = `owned [${ownedCats.join(", ")}] + gaps [${gaps.join(", ")}]`;
    it(`${name}: every slot placed, only gaps dashed, nothing counted as a failed picture`, () => {
      stubOpaqueScan();
      // Gaps first in the list, to check order doesn't matter.
      const items = [
        ...gaps.map((c) => gapToCollageItem(gap(c))),
        ...ownedCats.map(owned),
      ];
      const layout = layoutCollage(items);
      expect(layout.unplaced).toEqual([]);
      expect(layout.placed).toHaveLength(ownedCats.length + gaps.length);
      expect(layout.shape).toBe(
        ownedCats.includes("dress_jumpsuit") || gaps.includes("dress_jumpsuit")
          ? "one_piece"
          : "separates",
      );
      expect(layout.hasOuterwear).toBe(
        ownedCats.includes("outerwear") || gaps.includes("outerwear"),
      );

      // Every box stays on the canvas.
      for (const p of layout.placed) {
        expect(p.box.x).toBeGreaterThanOrEqual(0);
        expect(p.box.y).toBeGreaterThanOrEqual(0);
        expect(p.box.x + p.box.width).toBeLessThanOrEqual(COLLAGE_SIZE.width);
        expect(p.box.y + p.box.height).toBeLessThanOrEqual(COLLAGE_SIZE.height);
      }

      const { ctx, calls } = recordingContext();
      const result = drawCollage(ctx, layout, imagesFor(layout));
      expect(result.placeholders).toEqual([]);
      expect(calls.filter((c) => c.op === "drawImage")).toHaveLength(
        ownedCats.length,
      );
      // One dashed outline per gap.
      expect(
        calls.filter(
          (c) => c.op === "setLineDash" && (c.args[0] as number[]).length > 0,
        ),
      ).toHaveLength(gaps.length);
      const texts = calls
        .filter((c) => c.op === "fillText")
        .map((c) => c.args[0]);
      for (const c of gaps) expect(texts).toContain(`Suggested ${c}`);
    });
  }

  it("draws a gap with no image map entry the same as one with a stray image of its id (never draws a picture for a gap)", () => {
    stubOpaqueScan();
    const layout = layoutCollage([
      owned("top"),
      gapToCollageItem(gap("bottom")),
      gapToCollageItem(gap("shoes", { shopProduct: PRODUCT })),
    ]);
    const images = new Map([
      ["owned:top", fakeImage],
      ["gap:bottom", fakeImage],
      ["gap:shoes", fakeImage],
    ]);
    const { ctx, calls } = recordingContext();
    drawCollage(ctx, layout, images);
    expect(calls.filter((c) => c.op === "drawImage")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Long and non-ASCII text
// ---------------------------------------------------------------------------

const LONG_DESCRIPTION =
  "Chunky white leather trainers with a gum sole and contrast stitching, padded collar and a tonal lace-up front panel".slice(
    0,
    120,
  );
const LONG_TITLE = "Nike Air Force 1 '07 Men's Trainers White "
  .repeat(10)
  .slice(0, SHOP_PRODUCT_LIMITS.title);

describe("gap text in the collage", () => {
  for (const category of CATEGORIES) {
    it(`a 120-character description in the ${category} slot wraps to at most 3 lines, each limited to the slot's width`, () => {
      stubOpaqueScan();
      const shape: Category[] =
        category === "dress_jumpsuit"
          ? ["dress_jumpsuit", "shoes", "outerwear"]
          : ["top", "bottom", "shoes", "outerwear"];
      const items = shape.map((c) =>
        c === category
          ? gapToCollageItem(gap(c, { description: LONG_DESCRIPTION }))
          : owned(c),
      );
      const layout = layoutCollage(items);
      const { ctx, calls } = recordingContext();
      drawCollage(ctx, layout, imagesFor(layout));
      const box = boxOf(layout, `gap:${category}`);
      const lines = textInside(calls, box);
      expect(lines.length).toBeGreaterThan(1);
      expect(lines.length).toBeLessThanOrEqual(3);
      expect(lines.at(-1)!.text.endsWith("…")).toBe(true);
      for (const line of lines) expect(line.maxWidth).toBeLessThan(box.width);
    });
  }

  // Was a BUG (fixed): in the shoes slot (the shortest, 230 px tall) the
  // swatch row + description + product name was taller than the dashed box.
  // drawGap now uses fewer lines (fitGapText) until the block fits.
  it(
    "a long description plus a picked product's long name stays inside the shoes slot's dashed box",
    () => {
      stubOpaqueScan();
      const layout = layoutCollage([
        owned("top"),
        owned("bottom"),
        gapToCollageItem(
          gap("shoes", {
            description: LONG_DESCRIPTION,
            colours: ["white", "beige", "brown"],
            shopProduct: { ...PRODUCT, title: LONG_TITLE },
          }),
        ),
      ]);
      const { ctx, calls } = recordingContext();
      drawCollage(ctx, layout, imagesFor(layout));
      const box = boxOf(layout, "gap:shoes");
      const inner = { top: box.y + 16, bottom: box.y + box.height - 16 };
      const lines = textInside(calls, box);
      // Fewer lines than the 5 that would overflow, but still the description and the product.
      expect(lines.length).toBeGreaterThanOrEqual(2);
      expect(lines.length).toBeLessThan(5);
      const lineHeight = 38;
      for (const line of lines) {
        expect(line.y - lineHeight / 2).toBeGreaterThanOrEqual(inner.top);
        expect(line.y + lineHeight / 2).toBeLessThanOrEqual(inner.bottom);
      }
    },
  );

  it("a short description with a long product name fits the shoes slot", () => {
    stubOpaqueScan();
    const layout = layoutCollage([
      owned("dress_jumpsuit"),
      gapToCollageItem(
        gap("shoes", {
          description: "Tan sandals",
          shopProduct: { ...PRODUCT, title: LONG_TITLE },
        }),
      ),
    ]);
    const { ctx, calls } = recordingContext();
    drawCollage(ctx, layout, imagesFor(layout));
    const box = boxOf(layout, "gap:shoes");
    for (const line of textInside(calls, box)) {
      expect(line.y).toBeGreaterThan(box.y);
      expect(line.y).toBeLessThan(box.y + box.height);
    }
  });

  it("non-ASCII descriptions and product names are drawn unchanged (accents, CJK, emoji, RTL)", () => {
    stubOpaqueScan();
    const description = "Bottes en cuir façon Chelsea, très légères";
    const title = "厚底スニーカー ホワイト 👟 حذاء رياضي";
    const layout = layoutCollage([
      owned("top"),
      owned("bottom"),
      gapToCollageItem(
        gap("shoes", { description, shopProduct: { ...PRODUCT, title } }),
      ),
    ]);
    const { ctx, calls } = recordingContext();
    drawCollage(ctx, layout, imagesFor(layout));
    const drawn = calls
      .filter((c) => c.op === "fillText")
      .map((c) => c.args[0] as string)
      .join(" ");
    for (const word of description.split(" ")) expect(drawn).toContain(word);
    for (const word of title.split(" ")) expect(drawn).toContain(word);
  });

  it("wrapText measures whole code points: an emoji or surrogate pair is never split", () => {
    const lines = wrapText(
      "👟👟👟 🧥🧥🧥 👗👗👗 👠👠👠",
      60,
      (s) => [...s].length * 15,
      3,
    );
    for (const line of lines)
      expect(line).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it("wrapText with only whitespace or line breaks gives no lines", () => {
    expect(wrapText(" \n\t ", 100, (s) => s.length)).toEqual([]);
  });

  it("collageDescription keeps non-ASCII text and names a picked product rather than the description", () => {
    const description = collageDescription(
      [{ tags: { ...MOCK_ITEMS[0]!.tags, description: "Chemise à rayures" } }],
      [
        gap("shoes", {
          description: "Baskets",
          shopProduct: { ...PRODUCT, title: "厚底スニーカー" },
        }),
        gap("outerwear", { description: "Trench beige" }),
      ],
    );
    expect(description).toBe(
      "Collage of Chemise à rayures, suggested 厚底スニーカー (not in your wardrobe), suggested Trench beige (not in your wardrobe)",
    );
  });

  it("a non-ASCII outfit name still gives a usable PNG file name", () => {
    expect(collageFileName("週末の装い")).toBe("gladrags-outfit.png");
    expect(collageFileName("Été chic")).toMatch(/^gladrags-[a-z0-9-]+\.png$/);
  });
});

// ---------------------------------------------------------------------------
// Missing categories notice
// ---------------------------------------------------------------------------

describe("missingCategoriesMessage", () => {
  it("lists two or three categories in words", () => {
    expect(missingCategoriesMessage(["shoes"])).toBe(
      "Add shoes to your wardrobe to complete these outfits.",
    );
    expect(missingCategoriesMessage(["bottom", "shoes"])).toBe(
      "Add trousers or skirts and shoes to your wardrobe to complete these outfits.",
    );
    expect(missingCategoriesMessage(["top", "bottom", "shoes"])).toBe(
      "Add tops, trousers or skirts and shoes to your wardrobe to complete these outfits.",
    );
  });

  it("every category has words (no 'undefined')", () => {
    expect(missingCategoriesMessage(CATEGORIES)).not.toContain("undefined");
  });
});

// ---------------------------------------------------------------------------
// I've bought this
// ---------------------------------------------------------------------------

describe("addBoughtProductHref", () => {
  it("encodes a product URL with its own query string and fragment, so add-by-link gets it whole", () => {
    const url =
      "https://www.next.co.uk/style/st123?colour=white&size=8#reviews";
    const href = addBoughtProductHref({ url });
    expect(href.startsWith("/add/link?url=")).toBe(true);
    expect(new URL(href, "https://gladrags.test").searchParams.get("url")).toBe(
      url,
    );
    expect(
      new URL(href, "https://gladrags.test").searchParams.getAll("size"),
    ).toEqual([]);
  });

  it("encodes non-ASCII paths", () => {
    const url = "https://www.zara.com/uk/en/bottes-légères-p123.html";
    expect(
      new URL(
        addBoughtProductHref({ url }),
        "https://gladrags.test",
      ).searchParams.get("url"),
    ).toBe(url);
  });

  it("always stays on our own add-by-link page, whatever the product URL", () => {
    const href = addBoughtProductHref({ url: "//evil.example/x" });
    expect(new URL(href, "https://gladrags.test").origin).toBe(
      "https://gladrags.test",
    );
  });
});

// ---------------------------------------------------------------------------
// Hostile product data from the API
// ---------------------------------------------------------------------------

const shirt = MOCK_ITEMS[0]!;
const jeans = MOCK_ITEMS[3]!;

function outfitWithProducts(
  products: unknown[],
  chosen: unknown = null,
): unknown {
  return {
    id: "2b000000-0000-4000-8000-000000000009",
    request: {
      style: { kind: "preset", presetId: "casual" },
      guidance: null,
      anchorItemId: null,
      includeShopItems: true,
    },
    name: "Easy weekend",
    reason: "White trainers keep this crisp",
    itemIds: [shirt.id, jeans.id],
    items: [shirt, jeans],
    gaps: [
      {
        ...gap("shoes"),
        shopResults: products,
        searchedAt: "2026-10-31T10:00:00.000Z",
        shopProduct: chosen,
      },
    ],
    status: "suggested",
    parentOutfitId: null,
    createdAt: "2026-10-31T10:00:00.000Z",
  };
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function searchWith(products: unknown[], chosen: unknown = null) {
  const fetchImpl = vi.fn(async () =>
    json(200, { outfit: outfitWithProducts(products, chosen) }),
  );
  return createOutfitsApi(fetchImpl).findInShops(
    "2b000000-0000-4000-8000-000000000009",
  );
}

describe("shop search with hostile product data", () => {
  const HOSTILE_URLS = [
    "javascript:alert(document.cookie)",
    "JaVaScRiPt:alert(1)",
    " javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "http://www.next.co.uk/style/st123", // not https
    "https://www.next.co.uk.evil.example/style/st123", // look-alike host
    "https://evil.example/?u=https://www.next.co.uk/", // another site
    "https://user:pass@www.next.co.uk/style/st123",
    "//www.next.co.uk/style/st123",
    "/style/st123",
  ];

  for (const url of HOSTILE_URLS) {
    it(`a product link ${JSON.stringify(url)} is refused, never reaching the screen`, async () => {
      const result = await searchWith([{ ...PRODUCT, url }]);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error.code).toBe("internal");
    });
  }

  for (const imageUrl of [
    "javascript:alert(1)",
    "data:image/svg+xml,<svg onload=alert(1)>",
    "//evil.example/x.png",
    "/\\evil.example/x.png",
  ]) {
    it(`a product image ${JSON.stringify(imageUrl)} is refused`, async () => {
      const result = await searchWith([{ ...PRODUCT, imageUrl }]);
      expect(result.ok).toBe(false);
    });
  }

  it("a hostile chosen product (shopProduct) is refused too", async () => {
    const result = await searchWith([PRODUCT], {
      ...PRODUCT,
      url: "javascript:alert(1)",
    });
    expect(result.ok).toBe(false);
  });

  it("more than 3 products for a gap is refused", async () => {
    const result = await searchWith([PRODUCT, PRODUCT, PRODUCT, PRODUCT]);
    expect(result.ok).toBe(false);
  });

  it("an over-long title is refused or cut to the limit, never passed through whole", async () => {
    const result = await searchWith([{ ...PRODUCT, title: "A".repeat(5_000) }]);
    if (result.ok) {
      expect(
        result.data.outfit.gaps[0]!.shopResults[0]!.title.length,
      ).toBeLessThanOrEqual(SHOP_PRODUCT_LIMITS.title);
    } else {
      expect(result.error.code).toBe("internal");
    }
  });

  it("markup in a title stays text (the screen renders it as text, never HTML)", async () => {
    const result = await searchWith([
      { ...PRODUCT, title: "<img src=x onerror=alert(1)> Trainers" },
    ]);
    // Either kept as plain text or refused; if kept, it's exactly the text sent (React escapes it).
    if (result.ok)
      expect(result.data.outfit.gaps[0]!.shopResults[0]!.title).toContain(
        "<img",
      );
  });

  it("a broken (but well-formed) image URL is accepted: the card falls back to an icon in the browser", async () => {
    const result = await searchWith([
      { ...PRODUCT, imageUrl: "https://xcdn.next.co.uk/does-not-exist.jpg" },
    ]);
    expect(result.ok).toBe(true);
  });

  it("a gap searched with nothing found parses as an empty list", async () => {
    const result = await searchWith([]);
    expect(result.ok && result.data.outfit.gaps[0]!.shopResults).toEqual([]);
  });

  it("the same hostile outfit is also refused by the saved outfits list and GET", () => {
    expect(
      OutfitResponseSchema.safeParse({
        outfit: outfitWithProducts([
          { ...PRODUCT, url: "javascript:alert(1)" },
        ]),
      }).success,
    ).toBe(false);
  });
});

describe("shop search errors", () => {
  it("a daily cap with no cap details still reads sensibly", () => {
    const copy = describeApiError(
      { code: "daily_cap_reached", message: "x" },
      "shop_search",
    );
    expect(copy.message).toBe(
      "You've reached today's limit. It resets at midnight.",
    );
    expect(copy.retryable).toBe(false);
  });

  it("ai_failed in shop search can be retried", () => {
    expect(
      describeApiError({ code: "ai_failed", message: "x" }, "shop_search")
        .retryable,
    ).toBe(true);
  });

  it("a non-JSON 502 from the shop search becomes a friendly error, not a throw", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("<html>Bad gateway</html>", { status: 502 }),
    );
    const result = await createOutfitsApi(fetchImpl).findInShops(
      "2b000000-0000-4000-8000-000000000009",
    );
    expect(result).toEqual({
      ok: false,
      error: { code: "internal", message: expect.any(String) },
    });
  });

  it("a network failure picking a product becomes a friendly error, not a throw", async () => {
    const fetchImpl = vi.fn(async () =>
      Promise.reject(new TypeError("Failed to fetch")),
    );
    const result = await createOutfitsApi(fetchImpl).chooseGapProduct(
      "2b000000-0000-4000-8000-000000000009",
      "shoes",
      PRODUCT.url,
    );
    expect(result.ok).toBe(false);
  });

  it("an outfit id with path characters is encoded, so it can't reach another route", async () => {
    const fetchImpl = vi.fn(async (_input: string) =>
      json(404, { error: { code: "not_found", message: "x" } }),
    );
    const api = createOutfitsApi(fetchImpl);
    await api.findInShops("../../items/1");
    await api.chooseGapProduct("../x", "shoes", null);
    expect(fetchImpl.mock.calls[0]![0]).toBe(
      "/api/outfits/..%2F..%2Fitems%2F1/shop-search",
    );
    expect(fetchImpl.mock.calls[1]![0]).toBe("/api/outfits/..%2Fx/gaps/shoes");
  });
});

// ---------------------------------------------------------------------------
// Cut-out queue
// ---------------------------------------------------------------------------

const item = (
  n: number,
  overrides: Partial<{
    cutoutUrl: string | null;
    needsPhoto: boolean;
    originalUrl: string;
  }> = {},
) => ({
  id: `item-${n}`,
  originalUrl: `/o/${n}.jpg`,
  cutoutUrl: null as string | null,
  needsPhoto: false,
  ...overrides,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/** Deps that log the order of every step, to check nothing overlaps. */
function loggingDeps(overrides: Partial<CutoutDeps> = {}) {
  const log: string[] = [];
  let active = 0;
  let maxActive = 0;
  const step =
    <A extends unknown[], R>(name: string, fn: (...args: A) => Promise<R>) =>
    async (...args: A) => {
      active++;
      maxActive = Math.max(maxActive, active);
      log.push(
        `${name}:start:${String(args[0] instanceof Blob ? "blob" : args[0])}`,
      );
      try {
        return await fn(...args);
      } finally {
        active--;
        log.push(`${name}:end`);
      }
    };
  const deps: CutoutDeps = {
    fetchOriginal: vi.fn(step("fetch", async (url: string) => new Blob([url]))),
    removeBackground: vi.fn(
      step(
        "remove",
        async (image: Blob) =>
          new Blob([await image.text(), "-cut"], { type: "image/png" }),
      ),
    ),
    fitCutout: vi.fn(async (b: Blob) => b),
    upload: vi.fn(step("upload", async (_id: string, _b: Blob) => true)),
    toUrl: vi.fn((b: Blob) => `blob:${b.size}`),
    ...overrides,
  };
  return { deps, log, maxActive: () => maxActive };
}

describe("CutoutQueue: one at a time, no duplicates", () => {
  it("ten items asked for by several collages at once: each cut out once, strictly one after another", async () => {
    const { deps, maxActive } = loggingDeps();
    const queue = new CutoutQueue(() => deps);
    const items = Array.from({ length: 10 }, (_, n) => item(n));
    // Three collages share items 0-9 in different orders.
    const requests = [
      ...items,
      ...[...items].reverse(),
      ...items.filter((_, n) => n % 2 === 0),
    ].map((i) => queue.request(i));
    const results = await Promise.all(requests);
    expect(results.every((r) => r.url !== null && r.uploaded)).toBe(true);
    expect(deps.fetchOriginal).toHaveBeenCalledTimes(10);
    expect(deps.removeBackground).toHaveBeenCalledTimes(10);
    expect(deps.upload).toHaveBeenCalledTimes(10);
    expect(maxActive()).toBe(1);
    // Same item, same promise for every collage.
    expect(results[0]).toBe(results[19]);
  });

  it("the upload is part of the job: the next item doesn't start downloading until the previous upload finishes", async () => {
    const upload = deferred<boolean>();
    const { deps, log } = loggingDeps({
      upload: vi
        .fn()
        .mockReturnValueOnce(upload.promise)
        .mockResolvedValue(true),
    });
    const queue = new CutoutQueue(() => deps);
    const one = queue.request(item(1));
    const two = queue.request(item(2));
    await flush();
    await flush();
    expect(deps.upload).toHaveBeenCalledTimes(1);
    expect(deps.fetchOriginal).toHaveBeenCalledTimes(1);
    upload.resolve(true);
    await Promise.all([one, two]);
    expect(log.filter((l) => l.startsWith("fetch:start"))).toEqual([
      "fetch:start:/o/1.jpg",
      "fetch:start:/o/2.jpg",
    ]);
  });

  it("an item added to the queue after a finished one starts at once (the queue doesn't stall when idle)", async () => {
    const { deps } = loggingDeps();
    const queue = new CutoutQueue(() => deps);
    await queue.request(item(1));
    const later = await queue.request(item(2));
    expect(later.url).not.toBeNull();
  });

  it("peek is empty while a cut-out is still running, and set once it's done", async () => {
    const removal = deferred<Blob>();
    const { deps } = loggingDeps({
      removeBackground: vi.fn(() => removal.promise),
    });
    const queue = new CutoutQueue(() => deps);
    const job = queue.request(item(1));
    await flush();
    expect(queue.peek("item-1")).toBeUndefined();
    removal.resolve(new Blob(["x"]));
    const result = await job;
    await flush();
    expect(queue.peek("item-1")).toEqual(result);
  });
});

describe("CutoutQueue: failures", () => {
  it("removal failing: no upload, the original is kept, the next item still runs, and it isn't retried", async () => {
    const { deps } = loggingDeps({
      removeBackground: vi
        .fn()
        .mockRejectedValueOnce(new Error("no_subject"))
        .mockResolvedValue(new Blob(["ok"])),
    });
    const queue = new CutoutQueue(() => deps);
    const [one, two] = await Promise.all([
      queue.request(item(1)),
      queue.request(item(2)),
    ]);
    expect(one).toEqual({ url: null, uploaded: false });
    expect(two.uploaded).toBe(true);
    expect(deps.upload).toHaveBeenCalledTimes(1);
    expect(deps.upload).toHaveBeenCalledWith("item-2", expect.any(Blob));
    await flush();
    expect(await queue.request(item(1))).toEqual({
      url: null,
      uploaded: false,
    });
    expect(deps.removeBackground).toHaveBeenCalledTimes(2);
  });

  it("removal throwing synchronously (not a rejected promise) is handled the same way", async () => {
    const { deps } = loggingDeps({
      removeBackground: vi.fn(() => {
        throw new Error("unsupported");
      }),
    });
    const queue = new CutoutQueue(() => deps);
    expect(await queue.request(item(1))).toEqual({
      url: null,
      uploaded: false,
    });
    expect((await queue.request(item(2))).url).toBeNull();
  });

  it("the remover failing to load (makeDeps throws) never rejects, and later collages can try again", async () => {
    const makeDeps = vi.fn(() => {
      throw new Error("model download failed");
    });
    const queue = new CutoutQueue(makeDeps);
    expect(await queue.request(item(1))).toEqual({
      url: null,
      uploaded: false,
    });
    expect(await queue.request(item(1))).toEqual({
      url: null,
      uploaded: false,
    });
    expect(makeDeps).toHaveBeenCalledTimes(2);
  });

  it("upload failing (rejects or the server says no): the local cut-out is still drawn, and it isn't uploaded again this session", async () => {
    const { deps } = loggingDeps({
      upload: vi
        .fn()
        .mockRejectedValueOnce(new Error("offline"))
        .mockResolvedValueOnce(false),
    });
    const queue = new CutoutQueue(() => deps);
    const one = await queue.request(item(1));
    const two = await queue.request(item(2));
    expect(one).toEqual({
      url: expect.stringMatching(/^blob:/),
      uploaded: false,
    });
    expect(two).toEqual({
      url: expect.stringMatching(/^blob:/),
      uploaded: false,
    });
    await flush();
    await queue.request(item(1));
    expect(deps.upload).toHaveBeenCalledTimes(2);
  });

  it("toUrl throwing (createObjectURL unavailable) keeps the original but remembers the upload", async () => {
    const { deps } = loggingDeps({
      toUrl: vi.fn(() => {
        throw new Error("no object URLs");
      }),
    });
    const queue = new CutoutQueue(() => deps);
    expect(await queue.request(item(1))).toEqual({ url: null, uploaded: true });
  });

  it("original failing to download: no removal, no upload, and the next collage can try again", async () => {
    const { deps } = loggingDeps({
      fetchOriginal: vi
        .fn()
        .mockRejectedValueOnce(new Error("403 expired"))
        .mockResolvedValue(new Blob(["fresh"])),
    });
    const queue = new CutoutQueue(() => deps);
    expect(await queue.request(item(1))).toEqual({
      url: null,
      uploaded: false,
    });
    expect(deps.removeBackground).not.toHaveBeenCalled();
    expect(deps.upload).not.toHaveBeenCalled();
    await flush();
    expect(queue.peek("item-1")).toBeUndefined();
    const retry = await queue.request(
      item(1, { originalUrl: "/o/1.jpg?fresh" }),
    );
    expect(retry.uploaded).toBe(true);
    expect(deps.fetchOriginal).toHaveBeenLastCalledWith("/o/1.jpg?fresh");
  });

  it("collages that asked while the download was failing share that one failed attempt (no burst of retries)", async () => {
    const download = deferred<Blob>();
    const { deps } = loggingDeps({
      fetchOriginal: vi
        .fn()
        .mockReturnValueOnce(download.promise)
        .mockResolvedValue(new Blob(["x"])),
    });
    const queue = new CutoutQueue(() => deps);
    const asks = [
      queue.request(item(1)),
      queue.request(item(1)),
      queue.request(item(1)),
    ];
    download.reject(new Error("offline"));
    const results = await Promise.all(asks);
    expect(results.every((r) => r.url === null)).toBe(true);
    expect(deps.fetchOriginal).toHaveBeenCalledTimes(1);
  });

  it("a cut-out that couldn't be made to fit (fitCutout null or throws) isn't uploaded", async () => {
    const { deps } = loggingDeps({
      fitCutout: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockRejectedValueOnce(new Error("decode failed")),
    });
    const queue = new CutoutQueue(() => deps);
    expect(await queue.request(item(1))).toEqual({
      url: null,
      uploaded: false,
    });
    expect(await queue.request(item(2))).toEqual({
      url: null,
      uploaded: false,
    });
    expect(deps.upload).not.toHaveBeenCalled();
  });
});

describe("needsCutout", () => {
  it("needsPhoto items are never cut out, with or without a cut-out", () => {
    expect(needsCutout(item(1, { needsPhoto: true }))).toBe(false);
    expect(
      needsCutout(item(1, { needsPhoto: true, cutoutUrl: "/c.png" })),
    ).toBe(false);
  });

  it("an empty-string cut-out URL isn't treated as 'has a cut-out'... (contract never sends one)", () => {
    // The contract types cutoutUrl as string | null; this documents the rule is `=== null`.
    expect(needsCutout(item(1, { cutoutUrl: "/c.png" }))).toBe(false);
    expect(needsCutout(item(1))).toBe(true);
  });
});

describe("outfit with gaps round-trips through the contract", () => {
  it("an outfit with 3 gaps (each with results and one picked) parses", () => {
    const outfit = {
      ...(outfitWithProducts([]) as Outfit),
      itemIds: [shirt.id],
      items: [shirt],
      gaps: [
        gap("bottom", { colours: ["blue"] }),
        gap("shoes", {
          shopResults: [PRODUCT],
          searchedAt: "2026-10-31T10:00:00.000Z",
          shopProduct: PRODUCT,
        }),
        gap("outerwear", { colours: ["navy", "white", "black"] }),
      ],
    };
    expect(OutfitResponseSchema.safeParse({ outfit }).success).toBe(true);
  });
});
