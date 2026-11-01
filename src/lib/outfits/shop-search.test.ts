/**
 * "Find in my shops" and choosing a gap's product (ShopSearchService), with
 * the real Gemini provider class playing back recorded-style replies, a fake
 * page checker, the mock outfit store and an in-memory usage store. No network.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { OutfitSchema, type Outfit, type ShopProduct } from "@/contracts";
import { GeminiShopSearchProvider } from "@/lib/ai/gemini-shop-search";
import type { GeminiContentGenerator } from "@/lib/ai/gemini-ranking";
import { ApiException } from "@/lib/api/errors";
import { MOCK_USER } from "@/lib/auth/session";
import { MOCK_ITEMS } from "@/lib/mocks/fixtures";
import * as mock from "@/lib/mocks/store";
import { CapReachedError, DAILY_CAPS, InMemoryUsageStore, MONTHLY_AI_SPEND_CAP_PENCE, UsageGuard } from "@/lib/usage";
import { shopSearchReply } from "@/test/fixtures/shop-search";
import { MockOutfitRepository } from "./mock-repository";
import { ShopSearchService, candidatePages, type ShopPageCandidate, type ShopPageChecker } from "./shop-search";

const USER = MOCK_USER.id;
const NOW = new Date("2026-10-31T12:00:00Z");
const top = MOCK_ITEMS.find((i) => i.tags.category === "top")!;
const bottom = MOCK_ITEMS.find((i) => i.tags.category === "bottom")!;

let store: InMemoryUsageStore;
let replies: string[];
let calls: number;
let checked: ShopPageCandidate[];
let pageDelayMs: number;

/** Plays back reply texts in order (the last one repeats). */
const generator: GeminiContentGenerator = {
  async generateContent() {
    const text = replies[Math.min(calls++, replies.length - 1)]!;
    return { text };
  },
};

/** "Reads" a page from its link. Pages with "dead" in the link don't load. */
const pages: ShopPageChecker = {
  async check(candidate) {
    checked.push(candidate);
    if (pageDelayMs) await new Promise((r) => setTimeout(r, pageDelayMs));
    if (candidate.url.includes("dead")) return null;
    return { shopId: candidate.shopId, title: `Page ${new URL(candidate.url).pathname}`, url: candidate.url, priceText: "£30", imageUrl: null };
  },
};

function service(pageBudgetMs?: number) {
  return new ShopSearchService({
    repository: new MockOutfitRepository(),
    usage: new UsageGuard(store, undefined, () => NOW),
    provider: () => new GeminiShopSearchProvider(generator, "test-model"),
    pages,
    now: () => NOW,
    pageBudgetMs,
  });
}

function gapOutfit(chosen: ShopProduct | null = null): Outfit {
  return mock.insertOutfit(
    OutfitSchema.parse({
      id: crypto.randomUUID(),
      request: { style: { kind: "preset", presetId: "casual" }, guidance: null, anchorItemId: null, includeShopItems: true },
      name: "Gappy",
      reason: "Needs shoes and a jacket",
      itemIds: [top.id, bottom.id],
      items: [top, bottom],
      gaps: [
        { category: "shoes", subcategory: "trainers", colours: ["white"], description: "White leather trainers", shopProduct: chosen },
        { category: "outerwear", subcategory: "jacket", colours: ["olive"], description: "Olive utility jacket" },
      ],
      status: "suggested",
      parentOutfitId: null,
      createdAt: NOW.toISOString(),
    }),
  );
}

const count = (kind: string) => store.events.filter((e) => e.kind === kind).length;

beforeEach(() => {
  mock.resetMockStore();
  store = new InMemoryUsageStore(() => NOW);
  replies = [shopSearchReply("trainers-and-jacket")];
  calls = 0;
  checked = [];
  pageDelayMs = 0;
});

describe("search", () => {
  it("keeps only https links on the favourite shops, checks each page, and stores up to three per gap", async () => {
    const outfit = gapOutfit();
    const found = await service().search(USER, outfit.id);
    const [shoes, jacket] = found.gaps;

    // Off-site, lookalike, typo-squat, http, a non-favourite shop, credentials, an odd port and a repeat are never fetched.
    const hosts = new Set(checked.map((c) => new URL(c.url).host));
    expect(hosts).toEqual(new Set(["www.next.co.uk", "www.marksandspencer.com", "www.newlook.com"]));
    expect(checked.map((c) => c.url)).not.toContain("https://www.next.co.uk/style/st123456/k98765#1");
    expect(checked.filter((c) => c.url === "https://www.next.co.uk/style/st123456/k98765")).toHaveLength(1);

    expect(shoes!.shopResults.map((p) => p.shopId)).toEqual(["next", "marks_and_spencer", "new_look"]);
    expect(shoes!.shopResults).toHaveLength(3);
    expect(jacket!.shopResults.map((p) => p.url)).toEqual(["https://www.marksandspencer.com/pure-cotton-utility-jacket/p/clp60598765"]);
    expect(shoes!.searchedAt).toBe(NOW.toISOString());
    expect(OutfitSchema.parse(found)).toEqual(found);
    expect(mock.getOutfit(outfit.id)!.gaps).toEqual(found.gaps);
  });

  it("counts one search per outfit and meters the grounded call as shop_grounding", async () => {
    await service().search(USER, gapOutfit().id);
    expect(count("shop_search")).toBe(1);
    expect(count("shop_grounding")).toBe(1);
    expect(store.events.find((e) => e.kind === "shop_grounding")!.provider).toBe("gemini");
  });

  it("drops pages that don't load, and keeps a product the user already chose", async () => {
    const chosen: ShopProduct = { shopId: "next", title: "Old pick", url: "https://www.next.co.uk/old", priceText: "£20", imageUrl: null };
    const outfit = gapOutfit(chosen);
    replies = [JSON.stringify({ gaps: [{ category: "shoes", candidates: [{ url: "https://www.next.co.uk/dead-page", title: "x" }, { url: "https://www.next.co.uk/live", title: "y" }] }] })];
    const found = await service().search(USER, outfit.id);
    expect(found.gaps[0]!.shopResults.map((p) => p.url)).toEqual(["https://www.next.co.uk/live"]);
    expect(found.gaps[0]!.shopProduct).toEqual(chosen);
    // A gap the reply had no entry for is searched, with nothing found.
    expect(found.gaps[1]).toMatchObject({ shopResults: [], searchedAt: NOW.toISOString() });
  });

  it("only searches the user's own favourite shops", async () => {
    mock.setFavouriteShops(["zara"]);
    const found = await service().search(USER, gapOutfit().id);
    expect(checked.map((c) => [c.shopId, c.url])).toEqual([["zara", "https://www.zara.com/uk/en/leather-trainers-p123.html"]]);
    expect(found.gaps[0]!.shopResults.map((p) => p.shopId)).toEqual(["zara"]);
    expect(found.gaps[1]!.shopResults).toEqual([]);
  });

  it("drops page checks that run past the time budget", async () => {
    pageDelayMs = 200;
    const found = await service(50).search(USER, gapOutfit().id);
    expect(found.gaps.every((g) => g.shopResults.length === 0)).toBe(true);
    expect(found.gaps[0]!.searchedAt).toBe(NOW.toISOString());
  });

  it("retries a bad reply once (prose, an unknown gap) and uses the good one", async () => {
    replies = [shopSearchReply("unknown-gap"), shopSearchReply("trainers-and-jacket")];
    const found = await service().search(USER, gapOutfit().id);
    expect(calls).toBe(2);
    expect(found.gaps[0]!.shopResults).toHaveLength(3);
    expect(count("shop_grounding")).toBe(2);
  });

  it.each(["prose", "truncated", "duplicate-gap", "unknown-gap"])("ai_failed after two %s replies; the search stays counted", async (name) => {
    replies = [shopSearchReply(name)];
    const error = await service().search(USER, gapOutfit().id).catch((e: unknown) => e);
    expect((error as ApiException).code).toBe("ai_failed");
    expect(calls).toBe(2);
    expect(count("shop_search")).toBe(1);
    expect(count("shop_grounding")).toBe(2);
  });

  it("refuses an outfit with no gaps (bad_request) or someone else's (not_found), counting nothing", async () => {
    const plain = mock.insertOutfit({ ...gapOutfit(), id: crypto.randomUUID(), gaps: [] });
    expect(((await service().search(USER, plain.id).catch((e: unknown) => e)) as ApiException).code).toBe("bad_request");
    expect(((await service().search(USER, "9f000000-0000-4000-8000-000000000000").catch((e: unknown) => e)) as ApiException).code).toBe("not_found");
    expect(store.events).toEqual([]);
    expect(calls).toBe(0);
  });

  it("refuses at the daily cap before calling the model", async () => {
    const outfit = gapOutfit();
    for (let i = 0; i < DAILY_CAPS.shop_search; i++) await service().search(USER, outfit.id);
    const error = await service().search(USER, outfit.id).catch((e: unknown) => e);
    expect((error as CapReachedError).cap).toBe("shop_searches_per_day");
    expect(calls).toBe(DAILY_CAPS.shop_search);
  });

  it("refuses while AI is paused, and gives the count back if the pause comes after counting", async () => {
    await store.record({ userId: null, kind: "tagging", costPence: MONTHLY_AI_SPEND_CAP_PENCE, provider: "gemini" });
    const error = await service().search(USER, gapOutfit().id).catch((e: unknown) => e);
    expect((error as CapReachedError).cap).toBe("monthly_ai_spend");
    expect(count("shop_search")).toBe(0);
    expect(calls).toBe(0);
  });

  it("gives the count back when AI pauses after the search was counted but before the model call", async () => {
    const usage = new UsageGuard(store, undefined, () => NOW);
    const reserve = usage.reserveAction.bind(usage);
    usage.reserveAction = async (userId, action) => {
      const reservation = await reserve(userId, action);
      // Another request takes the month to the cap in between.
      await store.record({ userId: null, kind: "tagging", costPence: MONTHLY_AI_SPEND_CAP_PENCE, provider: "gemini" });
      return reservation;
    };
    const paused = new ShopSearchService({
      repository: new MockOutfitRepository(),
      usage,
      provider: () => new GeminiShopSearchProvider(generator, "test-model"),
      pages,
      now: () => NOW,
    });
    const error = await paused.search(USER, gapOutfit().id).catch((e: unknown) => e);
    expect((error as CapReachedError).cap).toBe("monthly_ai_spend");
    expect(calls).toBe(0);
    expect(count("shop_search")).toBe(0);
  });
});

describe("candidatePages (pure)", () => {
  it("keeps favourite-shop https links for the outfit's gaps only, without repeats, at most 5 per gap", () => {
    const many = Array.from({ length: 8 }, (_, n) => ({ url: `https://www.next.co.uk/p/${n}`, title: null }));
    const pages = candidatePages(
      { gaps: [{ category: "shoes", candidates: many }, { category: "bottom", candidates: many }] },
      new Set(["shoes"]),
      ["next"],
    );
    expect([...pages.keys()]).toEqual(["shoes"]);
    expect(pages.get("shoes")!.map((p) => p.url)).toEqual(many.slice(0, 5).map((c) => c.url));
  });
});

describe("chooseProduct", () => {
  it("copies the product from the gap's stored results, and clears it with null", async () => {
    const outfit = gapOutfit();
    const found = await service().search(USER, outfit.id);
    const pick = found.gaps[0]!.shopResults[1]!;
    const chosen = await service().chooseProduct(USER, outfit.id, "shoes", pick.url);
    expect(chosen.gaps[0]!.shopProduct).toEqual(pick);
    expect(chosen.gaps[0]!.shopResults).toEqual(found.gaps[0]!.shopResults);
    expect(chosen.gaps[1]!.shopProduct).toBeNull();
    const cleared = await service().chooseProduct(USER, outfit.id, "shoes", null);
    expect(cleared.gaps[0]!.shopProduct).toBeNull();
    expect(store.events.filter((e) => e.kind !== "shop_search" && e.kind !== "shop_grounding")).toEqual([]);
  });

  it("refuses a link that isn't one of that gap's results, even one from another gap", async () => {
    const outfit = gapOutfit();
    const found = await service().search(USER, outfit.id);
    const jacketUrl = found.gaps[1]!.shopResults[0]!.url;
    for (const url of ["https://www.next.co.uk/made-up", jacketUrl]) {
      const error = (await service().chooseProduct(USER, outfit.id, "shoes", url).catch((e: unknown) => e)) as ApiException;
      expect(error.code).toBe("bad_request");
    }
  });

  it("not_found for a slot without a gap, or an unknown outfit", async () => {
    const outfit = gapOutfit();
    expect(((await service().chooseProduct(USER, outfit.id, "top", null).catch((e: unknown) => e)) as ApiException).code).toBe("not_found");
    expect(((await service().chooseProduct(USER, "9f000000-0000-4000-8000-000000000000", "shoes", null).catch((e: unknown) => e)) as ApiException).code).toBe("not_found");
  });
});
