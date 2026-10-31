import { z } from "zod";
import { emptyToNull, scrapedText } from "./common";
import { SourceUrlSchema } from "./item";

/**
 * The fixed list of UK high-street shops a user can pick as favourites
 * (spec: "Gaps and shop suggestions"). Shop search only keeps product
 * links on a chosen shop's own website, so each shop lists the domains
 * its product pages live on. A link matches a domain if its host is that
 * domain or a subdomain of it (www.next.co.uk matches next.co.uk).
 *
 * Adding a shop needs a migration too: the user_settings check constraint
 * lists the IDs (supabase/schema-vocab.test.ts checks they agree).
 *
 * Primark is left out on purpose: it has no UK online shop to link to.
 */
export const SHOPS = [
  { id: "next", name: "Next", domains: ["next.co.uk"] },
  { id: "marks_and_spencer", name: "M&S", domains: ["marksandspencer.com"] },
  { id: "new_look", name: "New Look", domains: ["newlook.com"] },
  { id: "john_lewis", name: "John Lewis", domains: ["johnlewis.com"] },
  { id: "river_island", name: "River Island", domains: ["riverisland.com"] },
  { id: "zara", name: "Zara", domains: ["zara.com"] },
  { id: "hm", name: "H&M", domains: ["hm.com"] },
  { id: "uniqlo", name: "Uniqlo", domains: ["uniqlo.com"] },
  { id: "asos", name: "ASOS", domains: ["asos.com"] },
  { id: "mango", name: "Mango", domains: ["mango.com"] },
  { id: "matalan", name: "Matalan", domains: ["matalan.co.uk"] },
  { id: "fatface", name: "FatFace", domains: ["fatface.com"] },
] as const satisfies readonly { id: string; name: string; domains: readonly string[] }[];

export type Shop = (typeof SHOPS)[number];
export const SHOP_IDS = SHOPS.map((shop) => shop.id) as [Shop["id"], ...Shop["id"][]];
export const ShopIdSchema = z.enum(SHOP_IDS);
export type ShopId = z.infer<typeof ShopIdSchema>;

export const SHOPS_BY_ID: Readonly<Record<ShopId, Shop>> = Object.fromEntries(SHOPS.map((s) => [s.id, s])) as Record<ShopId, Shop>;

/** A new user's favourite shops (Cheryl's choice). */
export const DEFAULT_FAVOURITE_SHOP_IDS: readonly ShopId[] = ["next", "marks_and_spencer", "new_look"];

/** At least one favourite shop, no duplicates. */
export const FavouriteShopIdsSchema = z
  .array(ShopIdSchema)
  .min(1, { error: "Pick at least one shop" })
  .max(SHOPS.length)
  .refine((ids) => new Set(ids).size === ids.length, { error: "No duplicates" });

/** True if `host` is `domain` or a subdomain of it. Case-insensitive; ignores a trailing dot. */
export function hostMatchesDomain(host: string, domain: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  const d = domain.toLowerCase();
  return h === d || h.endsWith(`.${d}`);
}

/**
 * Which of these shops a link belongs to, or null. Only https links count:
 * every listed shop serves its product pages over https.
 */
export function shopForUrl(url: string, shopIds: readonly ShopId[] = SHOP_IDS): ShopId | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port) return null;
  for (const id of shopIds) {
    if (SHOPS_BY_ID[id].domains.some((domain) => hostMatchesDomain(parsed.hostname, domain))) return id;
  }
  return null;
}

export const SHOP_PRODUCT_LIMITS = { title: 200, price: 40 } as const;

/**
 * A product the server found on one of the user's shops for an outfit gap,
 * after confirming the page exists (fetched through the add-by-link
 * fetcher, with its safety checks). Title, price and image come from that
 * page, not from the model.
 */
export const ShopProductSchema = z
  .object({
    shopId: ShopIdSchema,
    title: scrapedText(SHOP_PRODUCT_LIMITS.title).pipe(z.string()),
    /** The product page, on the shop's own website. "Add to wardrobe" sends it to POST /api/items/link. */
    url: SourceUrlSchema,
    /** As the page shows it, e.g. "£35" or "£29.50 - £35". Null if the page didn't say. */
    priceText: scrapedText(SHOP_PRODUCT_LIMITS.price),
    /**
     * The page's product image, or null. A full http(s) URL on the shop's
     * servers (an absolute path such as /mock/... in mock mode). See
     * CONTRACTS.md about showing it (Content Security Policy, collages).
     */
    imageUrl: z.preprocess(emptyToNull, z.union([SourceUrlSchema, z.string().regex(/^\/(?![\/\\])\S+$/)]).nullable()),
  })
  .refine((p) => shopForUrl(p.url, [p.shopId]) !== null, {
    path: ["url"],
    error: "The link isn't on that shop's website",
  });
export type ShopProduct = z.infer<typeof ShopProductSchema>;

/** Most products shown per gap. */
export const SHOP_PRODUCTS_PER_GAP = 3;
