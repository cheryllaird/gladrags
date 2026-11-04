/**
 * QA (milestone 5, C4): "Find in my shops" and choosing a gap product,
 * adversarially. The real Gemini provider class plays back recorded-style
 * replies (src/test/fixtures/gemini-shop-search/), page checks are faked,
 * usage is in memory. No network.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { OutfitSchema, SHOP_PRODUCTS_PER_GAP, type Outfit, type OutfitGap, type ShopId, type ShopProduct } from "@/contracts";
import { GeminiShopSearchProvider } from "@/lib/ai/gemini-shop-search";
import type { GeminiContentGenerator } from "@/lib/ai/gemini-ranking";
import type { ShopSearchProvider } from "@/lib/ai/types";
import { ApiException } from "@/lib/api/errors";
import { MOCK_USER } from "@/lib/auth/session";
import { MOCK_ITEMS } from "@/lib/mocks/fixtures";
import * as mock from "@/lib/mocks/store";
import { CapReachedError, DAILY_CAPS, InMemoryUsageStore, MONTHLY_AI_SPEND_CAP_PENCE, UsageGuard } from "@/lib/usage";
import { shopSearchReply } from "@/test/fixtures/shop-search";
import { MockOutfitRepository } from "./mock-repository";
import { ShopSearchService, candidatePages, type ShopPageCandidate, type ShopPageChecker } from "./shop-search";

const USER = MOCK_USER.id;
const OTHER_USER = "0b000000-0000-4000-8000-0000000000ff";
const NOW = new Date("2026-10-31T12:00:00Z");
const top = MOCK_ITEMS.find((i) => i.tags.category === "top")!;
const bottom = MOCK_ITEMS.find((i) => i.tags.category === "bottom")!;

/** The mock store has one user; this one answers "not found" for anyone else, as Supabase does. */
class OneUserRepository extends MockOutfitRepository {
  override async getOutfit(userId: string, outfitId: string) {
    return userId === USER ? super.getOutfit(userId, outfitId) : null;
  }
  override async updateGaps(userId: string, outfitId: string, gaps: readonly OutfitGap[]) {
    return userId === USER ? super.updateGaps(userId, outfitId, gaps) : null;
  }
}

let store: InMemoryUsageStore;
let replies: string[];
let calls: number;
let throwing: number;
let checked: ShopPageCandidate[];
let pageResult: (c: ShopPageCandidate) => ShopProduct | null | Promise<ShopProduct | null>;

const generator: GeminiContentGenerator = {
  async generateContent() {
    calls++;
    if (throwing > 0) {
      throwing--;
      throw new Error("503 Service Unavailable");
    }
    return { text: replies[Math.min(calls - 1, replies.length - 1)]! };
  },
};

const pages: ShopPageChecker = {
  async check(candidate) {
    checked.push(candidate);
    return pageResult(candidate);
  },
};

const product = (c: ShopPageCandidate, overrides: Partial<ShopProduct> = {}): ShopProduct => ({
  shopId: c.shopId,
  title: `Page ${new URL(c.url).pathname}`,
  url: c.url,
  priceText: "£30",
  imageUrl: null,
  ...overrides,
});

function service(options: { usage?: UsageGuard; provider?: () => ShopSearchProvider; pageBudgetMs?: number } = {}) {
  return new ShopSearchService({
    repository: new OneUserRepository(),
    usage: options.usage ?? new UsageGuard(store, undefined, () => NOW),
    provider: options.provider ?? (() => new GeminiShopSearchProvider(generator, "test-model")),
    pages,
    now: () => NOW,
    pageBudgetMs: options.pageBudgetMs,
  });
}

function gapOutfit(gaps: Partial<OutfitGap>[] = [
  { category: "shoes", subcategory: "trainers", colours: ["white"], description: "White leather trainers" },
  { category: "outerwear", subcategory: "jacket", colours: ["olive"], description: "Olive utility jacket" },
]): Outfit {
  return mock.insertOutfit(
    OutfitSchema.parse({
      id: crypto.randomUUID(),
      request: { style: { kind: "preset", presetId: "casual" }, guidance: null, anchorItemId: null, includeShopItems: true },
      name: "Gappy",
      reason: "Needs shoes and a jacket",
      itemIds: [top.id, bottom.id],
      items: [top, bottom],
      gaps,
      status: "suggested",
      parentOutfitId: null,
      createdAt: NOW.toISOString(),
    }),
  );
}

const count = (kind: string) => store.events.filter((e) => e.kind === kind).length;
const codeOf = async (p: Promise<unknown>) => {
  const e = await p.catch((error: unknown) => error);
  return e instanceof ApiException ? e.code : e instanceof CapReachedError ? e.cap : e;
};
const reply = (gaps: { category: string; candidates: { url: string; title?: string }[] }[]) => JSON.stringify({ gaps });

beforeEach(() => {
  mock.resetMockStore();
  store = new InMemoryUsageStore(() => NOW);
  replies = [shopSearchReply("trainers-and-jacket")];
  calls = 0;
  throwing = 0;
  checked = [];
  pageResult = (c) => product(c);
});

// ---------------------------------------------------------------------------
// Links in the grounded reply
// ---------------------------------------------------------------------------

describe("hostile links in a grounded reply", () => {
  it("fetches only https pages on a favourite shop's own domain (recorded-style fixture)", async () => {
    replies = [shopSearchReply("qa-hostile-links")];
    const found = await service().search(USER, gapOutfit().id);
    for (const c of checked) {
      const url = new URL(c.url);
      expect(url.protocol).toBe("https:");
      expect(url.username + url.password + url.port).toBe("");
      expect(["www.next.co.uk", "www.marksandspencer.com", "www.newlook.com"]).toContain(url.hostname);
    }
    // The only good jacket link is kept once, without its fragment.
    expect(found.gaps[1]!.shopResults.map((p) => p.url)).toEqual(["https://www.marksandspencer.com/p/clp1?utm_source=gemini"]);
    // Every one of the first 8 shoes links is hostile: nothing to show.
    expect(found.gaps[0]!.shopResults).toEqual([]);
  });

  it.each([
    ["https://next.co.uk.evil.example/p"],
    ["https://evilnext.co.uk/p"],
    ["https://www.nеxt.co.uk/p"],
    ["https://www.next.co.uk.еvil.com/p"],
    ["https://www.next.co.uk%2eevil.example/p"],
    ["http://www.next.co.uk/p"],
    ["https://u:p@www.next.co.uk/p"],
    ["https://www.next.co.uk@evil.example/p"],
    ["https://evil.example\\@www.next.co.uk/p"],
    ["https://www.next.co.uk:8443/p"],
    ["https://www.next.co.uk:80/p"],
    ["https://93.184.215.14/p"],
    ["https://[::1]/p"],
    ["https://localhost/p"],
    ["javascript:alert(1)"],
    ["data:text/html,<p>"],
    ["https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc"],
    ["https://www.zara.com/p"], // a real shop, but not a favourite
  ])("drops %s", (url) => {
    const pagesFor = candidatePages({ gaps: [{ category: "shoes", candidates: [{ url, title: "x" }] }] }, new Set(["shoes"]), ["next", "marks_and_spencer", "new_look"]);
    expect(pagesFor.get("shoes")).toEqual([]);
  });

  it.each([
    ["https://www.next.co.uk:443/p", "https://www.next.co.uk/p"],
    ["https://WWW.NEXT.CO.UK/p", "https://www.next.co.uk/p"],
    ["https://next.co.uk/p", "https://next.co.uk/p"],
    ["https://www.next.co.uk/p#reviews", "https://www.next.co.uk/p"],
  ])("keeps %s (normalised to %s)", (url, expected) => {
    const pagesFor = candidatePages({ gaps: [{ category: "shoes", candidates: [{ url, title: "x" }] }] }, new Set(["shoes"]), ["next"]);
    expect(pagesFor.get("shoes")!.map((p) => p.url)).toEqual([expected]);
  });
});

// ---------------------------------------------------------------------------
// Results per gap
// ---------------------------------------------------------------------------

describe("results per gap", () => {
  it("at most 3 products per gap even when 8 good pages load; only 5 are fetched", async () => {
    const eight = Array.from({ length: 8 }, (_, n) => ({ url: `https://www.next.co.uk/style/st${n}`, title: `T${n}` }));
    replies = [reply([{ category: "shoes", candidates: eight }])];
    const found = await service().search(USER, gapOutfit().id);
    expect(checked).toHaveLength(5);
    expect(found.gaps[0]!.shopResults.map((p) => p.url)).toEqual(eight.slice(0, SHOP_PRODUCTS_PER_GAP).map((c) => c.url));
  });

  it("two links that land on the same product page count once", async () => {
    replies = [reply([{ category: "shoes", candidates: [
      { url: "https://www.next.co.uk/a" },
      { url: "https://www.next.co.uk/b" },
      { url: "https://www.next.co.uk/c" },
    ] }])];
    pageResult = (c) => product(c, { url: c.url.endsWith("/c") ? c.url : "https://www.next.co.uk/canonical" });
    const found = await service().search(USER, gapOutfit().id);
    expect(found.gaps[0]!.shopResults.map((p) => p.url)).toEqual(["https://www.next.co.uk/canonical", "https://www.next.co.uk/c"]);
  });

  it("keeps the model's order even when later pages answer first", async () => {
    replies = [reply([{ category: "shoes", candidates: [1, 2, 3].map((n) => ({ url: `https://www.next.co.uk/p${n}` })) }])];
    pageResult = async (c) => {
      await new Promise((r) => setTimeout(r, c.url.endsWith("1") ? 30 : 1));
      return product(c);
    };
    const found = await service().search(USER, gapOutfit().id);
    expect(found.gaps[0]!.shopResults.map((p) => p.url)).toEqual([1, 2, 3].map((n) => `https://www.next.co.uk/p${n}`));
  });

  it("a page check that throws, or never settles, is dropped without failing the search", async () => {
    replies = [reply([{ category: "shoes", candidates: [{ url: "https://www.next.co.uk/boom" }, { url: "https://www.next.co.uk/hang" }, { url: "https://www.next.co.uk/ok" }] }])];
    pageResult = (c) => {
      if (c.url.endsWith("boom")) throw new Error("parser exploded");
      if (c.url.endsWith("hang")) return new Promise<ShopProduct | null>(() => {});
      return product(c);
    };
    const started = Date.now();
    const found = await service({ pageBudgetMs: 100 }).search(USER, gapOutfit().id);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(found.gaps[0]!.shopResults.map((p) => p.url)).toEqual(["https://www.next.co.uk/ok"]);
  });

  it("replacing results keeps the chosen product, even when the new search doesn't find it again", async () => {
    const outfit = gapOutfit();
    const first = await service().search(USER, outfit.id);
    const pick = first.gaps[0]!.shopResults[0]!;
    await service().chooseProduct(USER, outfit.id, "shoes", pick.url);
    replies = [reply([{ category: "shoes", candidates: [{ url: "https://www.next.co.uk/new-one" }] }])];
    calls = 0;
    const again = await service().search(USER, outfit.id);
    expect(again.gaps[0]!.shopResults.map((p) => p.url)).toEqual(["https://www.next.co.uk/new-one"]);
    expect(again.gaps[0]!.shopProduct).toEqual(pick);
  });
});

// ---------------------------------------------------------------------------
// Shops, caps, pause and failures
// ---------------------------------------------------------------------------

describe("favourite shops, caps, AI pause, failures", () => {
  it("with no favourite shops (the database forbids it, but the mock store doesn't), nothing is fetched", async () => {
    mock.setFavouriteShops([] as ShopId[]);
    const found = await service().search(USER, gapOutfit().id).catch((e: unknown) => e);
    expect(checked).toEqual([]);
    if (!(found instanceof Error)) for (const g of (found as Outfit).gaps) expect(g.shopResults).toEqual([]);
  });

  // Was BUG (QA, low, it.fails): the grounded call was made and counted
  // with no shops to keep links from. Fixed: bad_request before anything.
  it("with no favourite shops, the model isn't called and nothing is counted", async () => {
    mock.setFavouriteShops([] as ShopId[]);
    const error = (await service().search(USER, gapOutfit().id).catch((e: unknown) => e)) as ApiException;
    expect(error.code).toBe("bad_request");
    expect(error.message).toContain("Choose your shops first");
    expect(calls).toBe(0);
    expect(count("shop_search")).toBe(0);
  });

  it("passes only the favourite shops' names and domains to the model", async () => {
    mock.setFavouriteShops(["uniqlo", "asos"]);
    const seen: unknown[] = [];
    const provider: ShopSearchProvider = {
      name: "fake",
      async searchGaps(input) {
        seen.push(input);
        return { raw: { gaps: [] }, costPence: 0, provider: "fake", model: "fake" };
      },
    };
    await service({ provider: () => provider }).search(USER, gapOutfit().id);
    expect((seen[0] as { shops: { id: string }[] }).shops.map((s) => s.id)).toEqual(["uniqlo", "asos"]);
  });

  it("the daily cap holds under 15 searches fired at once: exactly 10 run", async () => {
    const outfit = gapOutfit();
    const results = await Promise.allSettled(Array.from({ length: 15 }, () => service().search(USER, outfit.id)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(DAILY_CAPS.shop_search);
    for (const r of results.filter((x) => x.status === "rejected")) {
      expect(((r as PromiseRejectedResult).reason as CapReachedError).cap).toBe("shop_searches_per_day");
    }
    expect(count("shop_search")).toBe(DAILY_CAPS.shop_search);
    expect(calls).toBe(DAILY_CAPS.shop_search);
  });

  it("at the cap, the provider isn't even made, and choosing a product still works (no AI)", async () => {
    const outfit = gapOutfit();
    const found = await service().search(USER, outfit.id);
    for (let i = 1; i < DAILY_CAPS.shop_search; i++) await service().search(USER, outfit.id);
    let made = 0;
    const capped = service({ provider: () => (made++, new GeminiShopSearchProvider(generator, "test-model")) });
    expect(await codeOf(capped.search(USER, outfit.id))).toBe("shop_searches_per_day");
    expect(made).toBe(0);
    const chosen = await capped.chooseProduct(USER, outfit.id, "shoes", found.gaps[0]!.shopResults[0]!.url);
    expect(chosen.gaps[0]!.shopProduct).not.toBeNull();
  });

  it("AI paused before the search: refused, nothing counted, model not called", async () => {
    await store.record({ userId: null, kind: "tagging", costPence: MONTHLY_AI_SPEND_CAP_PENCE, provider: "gemini" });
    expect(await codeOf(service().search(USER, gapOutfit().id))).toBe("monthly_ai_spend");
    expect(count("shop_search")).toBe(0);
    expect(calls).toBe(0);
  });

  it("AI pausing after counting but before the call gives the count back (other searches still allowed after the 1st)", async () => {
    const usage = new UsageGuard(store, undefined, () => NOW);
    const reserve = usage.reserveAction.bind(usage);
    let paused = false;
    usage.reserveAction = async (userId, action) => {
      const r = await reserve(userId, action);
      if (!paused) {
        paused = true;
        await store.record({ userId: null, kind: "tagging", costPence: MONTHLY_AI_SPEND_CAP_PENCE, provider: "gemini" });
      }
      return r;
    };
    expect(await codeOf(service({ usage }).search(USER, gapOutfit().id))).toBe("monthly_ai_spend");
    expect(count("shop_search")).toBe(0);
    expect(calls).toBe(0);
  });

  it("two failed model calls (the provider throws): ai_failed, still counted, both calls metered", async () => {
    throwing = 2;
    expect(await codeOf(service().search(USER, gapOutfit().id))).toBe("ai_failed");
    expect(calls).toBe(2);
    expect(count("shop_search")).toBe(1);
    expect(count("shop_grounding")).toBe(2);
    expect(checked).toEqual([]);
  });

  it("one failed call then a good reply: results, both calls metered, one search counted", async () => {
    throwing = 1;
    const found = await service().search(USER, gapOutfit().id);
    expect(found.gaps[0]!.shopResults.length).toBeGreaterThan(0);
    expect(calls).toBe(2);
    expect(count("shop_search")).toBe(1);
    expect(count("shop_grounding")).toBe(2);
  });

  it.each([
    ["an empty object", "{}"],
    ["gaps not an array", '{"gaps":"shoes"}'],
    ["an invented category", reply([{ category: "handbag", candidates: [{ url: "https://www.next.co.uk/p" }] }])],
  ])("%s twice: ai_failed, counted, nothing fetched", async (_label, text) => {
    replies = [text];
    expect(await codeOf(service().search(USER, gapOutfit().id))).toBe("ai_failed");
    expect(count("shop_search")).toBe(1);
    expect(checked).toEqual([]);
  });

  it("another user's outfit: not_found, nothing counted, no model call", async () => {
    const outfit = gapOutfit();
    expect(await codeOf(service().search(OTHER_USER, outfit.id))).toBe("not_found");
    expect(store.events).toEqual([]);
    expect(calls).toBe(0);
    expect(mock.getOutfit(outfit.id)!.gaps.every((g) => g.searchedAt === null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Choosing a product
// ---------------------------------------------------------------------------

describe("choosing a gap product", () => {
  async function searched() {
    const outfit = gapOutfit();
    const found = await service().search(USER, outfit.id);
    return { outfit, found };
  }

  it("refuses any URL before the gap has been searched", async () => {
    const outfit = gapOutfit();
    expect(await codeOf(service().chooseProduct(USER, outfit.id, "shoes", "https://www.next.co.uk/style/st123456/k98765"))).toBe("bad_request");
  });

  it.each([
    ["a made-up page on the right shop", "https://www.next.co.uk/made-up"],
    ["a stored result with a fragment added", "https://www.next.co.uk/style/st123456/k98765#x"],
    ["a stored result with a trailing slash", "https://www.next.co.uk/style/st123456/k98765/"],
    ["a stored result with a query added", "https://www.next.co.uk/style/st123456/k98765?ref=evil"],
    ["an off-site link", "https://evil.example/style/st123456/k98765"],
  ])("refuses %s", async (_label, url) => {
    const { outfit, found } = await searched();
    expect(found.gaps[0]!.shopResults.map((p) => p.url)).toContain("https://www.next.co.uk/style/st123456/k98765");
    expect(await codeOf(service().chooseProduct(USER, outfit.id, "shoes", url))).toBe("bad_request");
    expect(mock.getOutfit(outfit.id)!.gaps[0]!.shopProduct).toBeNull();
  });

  it("refuses another outfit's result for the same slot", async () => {
    const a = await searched();
    const b = gapOutfit([{ category: "shoes", subcategory: "boots", colours: ["black"], description: "Black boots" }]);
    replies = [reply([{ category: "shoes", candidates: [{ url: "https://www.next.co.uk/only-b" }] }])];
    calls = 0;
    await service().search(USER, b.id);
    expect(await codeOf(service().chooseProduct(USER, a.outfit.id, "shoes", "https://www.next.co.uk/only-b"))).toBe("bad_request");
  });

  it("the stored product is the search's copy, whatever the phone might add", async () => {
    const { outfit, found } = await searched();
    const pick = found.gaps[0]!.shopResults[2]!;
    const chosen = await service().chooseProduct(USER, outfit.id, "shoes", pick.url);
    expect(chosen.gaps[0]!.shopProduct).toEqual(pick);
    expect(mock.getOutfit(outfit.id)!.gaps[0]!.shopProduct).toEqual(pick);
    // The other gap is untouched.
    expect(chosen.gaps[1]).toEqual(found.gaps[1]);
  });

  it("clearing works, and clearing twice is harmless", async () => {
    const { outfit, found } = await searched();
    await service().chooseProduct(USER, outfit.id, "shoes", found.gaps[0]!.shopResults[0]!.url);
    expect((await service().chooseProduct(USER, outfit.id, "shoes", null)).gaps[0]!.shopProduct).toBeNull();
    expect((await service().chooseProduct(USER, outfit.id, "shoes", null)).gaps[0]!.shopProduct).toBeNull();
    expect(mock.getOutfit(outfit.id)!.gaps[0]!.shopResults).toEqual(found.gaps[0]!.shopResults);
  });

  it("another user's outfit is refused (not_found), for choosing and for clearing, and nothing changes", async () => {
    const { outfit, found } = await searched();
    const url = found.gaps[0]!.shopResults[0]!.url;
    expect(await codeOf(service().chooseProduct(OTHER_USER, outfit.id, "shoes", url))).toBe("not_found");
    expect(await codeOf(service().chooseProduct(OTHER_USER, outfit.id, "shoes", null))).toBe("not_found");
    expect(mock.getOutfit(outfit.id)!.gaps[0]!.shopProduct).toBeNull();
  });

  it("a slot without a gap is not_found even with a valid URL from another slot", async () => {
    const { outfit, found } = await searched();
    const jacket = found.gaps[1]!.shopResults[0]!.url;
    expect(await codeOf(service().chooseProduct(USER, outfit.id, "top", jacket))).toBe("not_found");
  });
});
