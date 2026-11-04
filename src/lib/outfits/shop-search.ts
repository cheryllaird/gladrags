/**
 * "Find in my shops" and choosing a product for a gap (spec: "Gaps and
 * shop suggestions"; CONTRACTS.md section 5).
 *
 * Search, for an outfit with gaps:
 * 1. Check the daily shop search cap and the AI pause, then count one
 *    search for the whole outfit (cap shop_searches_per_day).
 * 2. One grounded web search for all the gaps (ShopSearchProvider: Gemini
 *    with Google Search), limited to the user's favourite shops, metered as
 *    `shop_grounding`. The reply is checked with ShopSearchModelOutputSchema
 *    through callWithValidation (one retry). Entries for gaps the outfit
 *    doesn't have are ignored; a reply with only such entries is retried.
 * 3. Keep only links on a favourite shop's website (shopForUrl), and
 *    confirm each page through link-import's fetcher and parser
 *    (ShopPageChecker), in parallel within a time budget.
 * 4. Store up to SHOP_PRODUCTS_PER_GAP products per gap (shopResults,
 *    searchedAt), replacing earlier results and keeping a chosen product.
 *
 * The model only suggests links. Code decides which are kept, and every
 * product's title, price and image come from the shop's own page.
 *
 * The count is given back only if no model call was made (AI paused before
 * the first one). Once a call has been made it stays counted, whatever
 * happens next: a search whose model calls fail twice is `ai_failed`, and
 * the daily cap is what bounds the cost. With no favourite shops the
 * search is refused (`bad_request`) before anything is counted.
 */
import {
  SHOPS_BY_ID,
  SHOP_PRODUCTS_PER_GAP,
  ShopSearchModelOutputSchema,
  shopForUrl,
  type Category,
  type Outfit,
  type OutfitGap,
  type ShopId,
  type ShopProduct,
  type ShopSearchModelOutput,
} from "@/contracts";
import type { ShopSearchProvider } from "@/lib/ai/types";
import { callWithValidation } from "@/lib/ai/validate";
import { ApiException, notFound } from "@/lib/api/errors";
import type { UsageGuard, UsageReservation } from "@/lib/usage/guard";
import { SHOP_PAGE_BUDGET_MS, SHOP_PAGE_CHECKS_PER_GAP, SHOP_PAGE_CONCURRENCY } from "./config";
import type { OutfitRepository } from "./repository";
import { mapWithLimit } from "./thumbnails";

/** A candidate page to check: a link on one of the user's favourite shops. */
export interface ShopPageCandidate {
  url: string;
  shopId: ShopId;
  /** The model's title for the page. Not shown: the page's own title is. */
  title: string;
}

/** Confirms a candidate page and reads its product. */
export interface ShopPageChecker {
  /**
   * The product on the page, or null if it doesn't load in `timeoutMs`,
   * leaves the shop's website, or isn't a product page. Shouldn't throw for
   * a page that fails; anything thrown is treated as null.
   */
  check(candidate: ShopPageCandidate, timeoutMs: number): Promise<ShopProduct | null>;
}

export interface ShopSearchServiceDeps {
  repository: OutfitRepository;
  usage: UsageGuard;
  /** A function so choosing a product never needs the Gemini key. */
  provider: () => ShopSearchProvider;
  pages: ShopPageChecker;
  now?: () => Date;
  /** Time for all page checks together (tests shorten it). */
  pageBudgetMs?: number;
}

/** A promise that settles with `fallback` if `promise` hasn't settled within `ms`. */
function withDeadline<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), Math.max(0, ms));
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Pure: the pages worth checking for each gap. Keeps a candidate only if
 * its gap is one of the outfit's and its link is on a favourite shop
 * (shopForUrl, so https, the shop's domain or a subdomain, no lookalikes),
 * without repeats, at most SHOP_PAGE_CHECKS_PER_GAP per gap, in the
 * model's order.
 */
export function candidatePages(
  reply: ShopSearchModelOutput,
  gapCategories: ReadonlySet<Category>,
  favouriteShopIds: readonly ShopId[],
): Map<Category, ShopPageCandidate[]> {
  const pages = new Map<Category, ShopPageCandidate[]>();
  for (const entry of reply.gaps) {
    if (!gapCategories.has(entry.category)) continue;
    const kept: ShopPageCandidate[] = [];
    const seen = new Set<string>();
    for (const candidate of entry.candidates) {
      const shopId = shopForUrl(candidate.url, favouriteShopIds);
      if (!shopId) continue;
      const url = new URL(candidate.url);
      url.hash = "";
      if (seen.has(url.href)) continue;
      seen.add(url.href);
      kept.push({ url: url.href, shopId, title: candidate.title ?? "" });
      if (kept.length >= SHOP_PAGE_CHECKS_PER_GAP) break;
    }
    pages.set(entry.category, kept);
  }
  return pages;
}

export class ShopSearchService {
  private readonly now: () => Date;

  constructor(private readonly deps: ShopSearchServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** POST /api/outfits/[id]/shop-search */
  async search(userId: string, outfitId: string): Promise<Outfit> {
    const { repository, usage } = this.deps;
    const outfit = await repository.getOutfit(userId, outfitId);
    if (!outfit) throw notFound("That outfit");
    if (outfit.gaps.length === 0) {
      throw new ApiException("bad_request", "This outfit has nothing to find: every piece is from your wardrobe");
    }
    await usage.assertCanStart(userId, "shop_search");
    const favouriteShopIds = await repository.getFavouriteShopIds(userId);
    // Every link would be dropped, so don't pay for a search. (The database
    // requires at least one shop; this guards a missing or emptied list.)
    if (favouriteShopIds.length === 0) {
      throw new ApiException("bad_request", "Choose your shops first: pick at least one in Settings.");
    }
    const shops = favouriteShopIds.map((id) => SHOPS_BY_ID[id]);
    // Made before counting, so a missing API key isn't counted as a search.
    const provider = this.deps.provider();

    const counted: UsageReservation = await usage.reserveAction(userId, "shop_search");
    const gapCategories = new Set(outfit.gaps.map((g) => g.category));
    const meter = usage.meterAiCalls(userId, "shop_grounding", provider.name);
    // Whether a model call was made (and so may be billed), even one that failed.
    let modelCalled = false;
    let result;
    try {
      result = await callWithValidation(
        ShopSearchModelOutputSchema,
        () =>
          provider.searchGaps({
            gaps: outfit.gaps.map(({ category, subcategory, colours, description }) => ({ category, subcategory, colours, description })),
            shops: shops.map(({ id, name, domains }) => ({ id, name, domains })),
          }),
        {
          // Entries for gaps the outfit doesn't have are dropped (candidatePages).
          // A reply with none for its actual gaps misread the request: retry.
          check: (reply) =>
            reply.gaps.length > 0 && !reply.gaps.some((g) => gapCategories.has(g.category))
              ? `Results only for gaps the outfit doesn't have: ${reply.gaps.map((g) => g.category).join(", ")}`
              : null,
          beforeCall: meter.beforeCall,
          onCall: async (call) => {
            modelCalled = true;
            await meter.onCall(call);
          },
          provider: provider.name,
        },
      );
    } catch (error) {
      // AI paused before any model call (another request took the month to
      // the cap): nothing was searched or paid for, so give today's count
      // back. Once a call has been made it stays counted.
      if (!modelCalled) await counted.cancel().catch(() => {});
      throw error;
    }
    if (!result.ok) {
      console.warn("Shop search: model reply failed twice", { errors: result.errors.map((e) => e.slice(0, 200)) });
      throw new ApiException("ai_failed", "We couldn't search your shops just now. Please try again.");
    }

    const products = await this.checkPages(candidatePages(result.data, gapCategories, favouriteShopIds));
    const searchedAt = this.now().toISOString();
    // Re-read just before writing: the user may have picked a product (on an
    // earlier search's results) while this one ran. Only the results and the
    // search time change; each gap keeps its current pick.
    const current = await repository.getOutfit(userId, outfit.id);
    if (!current) throw notFound("That outfit");
    const gaps: OutfitGap[] = current.gaps.map((gap) => ({
      ...gap,
      shopResults: products.get(gap.category) ?? [],
      searchedAt,
    }));
    const updated = await repository.updateGaps(userId, outfit.id, gaps);
    if (!updated) throw notFound("That outfit");
    return updated;
  }

  /** PUT /api/outfits/[id]/gaps/[category]: pick one of the gap's stored results, or clear the pick. */
  async chooseProduct(userId: string, outfitId: string, category: Category, productUrl: string | null): Promise<Outfit> {
    const { repository } = this.deps;
    const outfit = await repository.getOutfit(userId, outfitId);
    if (!outfit) throw notFound("That outfit");
    const gap = outfit.gaps.find((g) => g.category === category);
    if (!gap) throw notFound("That gap");
    let shopProduct: ShopProduct | null = null;
    if (productUrl !== null) {
      // Copied from the stored results, so the phone can't plant a product of its own.
      shopProduct = gap.shopResults.find((p) => p.url === productUrl) ?? null;
      if (!shopProduct) {
        throw new ApiException("bad_request", "That product isn't one of the search results for this gap", {
          issues: [{ path: "productUrl", message: "Not one of this gap's results" }],
        });
      }
    }
    const gaps = outfit.gaps.map((g) => (g.category === category ? { ...g, shopProduct } : g));
    const updated = await repository.updateGaps(userId, outfit.id, gaps);
    if (!updated) throw notFound("That outfit");
    return updated;
  }

  /**
   * Check every candidate page at once (a few at a time) within the
   * budget, then keep up to SHOP_PRODUCTS_PER_GAP products per gap, in the
   * model's order, without the same product twice.
   */
  private async checkPages(pages: Map<Category, ShopPageCandidate[]>): Promise<Map<Category, ShopProduct[]>> {
    const budget = this.deps.pageBudgetMs ?? SHOP_PAGE_BUDGET_MS;
    const deadline = Date.now() + budget;
    const tasks = [...pages.entries()].flatMap(([category, candidates]) => candidates.map((candidate) => ({ category, candidate })));
    const checked = await mapWithLimit(tasks, SHOP_PAGE_CONCURRENCY, async ({ category, candidate }) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { category, product: null };
      const product = await withDeadline(
        this.deps.pages.check(candidate, remaining).catch((error: unknown) => {
          console.warn("Shop search: page check failed", { error: error instanceof Error ? error.name : "unknown" });
          return null;
        }),
        remaining,
        null,
      );
      return { category, product };
    });

    const products = new Map<Category, ShopProduct[]>();
    for (const { category, product } of checked) {
      if (!product) continue;
      const list = products.get(category) ?? [];
      if (list.length < SHOP_PRODUCTS_PER_GAP && !list.some((p) => p.url === product.url)) list.push(product);
      products.set(category, list);
    }
    return products;
  }
}
