/**
 * The price a product page shows, as text for display ("£35", "£29.50 -
 * £35"). Used by "Find in my shops" (outfit-engine) on top of
 * parseProductPage: add-by-link itself doesn't need a price.
 *
 * Reads schema.org Product JSON-LD offers first (Offer, AggregateOffer,
 * arrays, priceSpecification), then Open Graph / product meta tags. Like
 * the rest of the parser it treats the page as untrusted: only numbers
 * become prices, currency codes become a symbol for the usual three, and
 * the result is length-limited by the caller's schema.
 */
import { extractPageParts, type MetaTag } from "./html";
import { findProductNodes, parseJsonLd, type Json } from "./product";

const CURRENCY_SYMBOLS: Readonly<Record<string, string>> = { GBP: "£", EUR: "€", USD: "$" };

/** Offers walked per product, so a hostile page can't make this loop for long. */
const MAX_OFFERS = 50;

type JsonObject = { [key: string]: Json };

function isObject(value: Json | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: Json | undefined): Json[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** A non-negative amount from a number or a plain numeric string ("35", "35.00", "1,035.50"). */
export function parseAmount(value: Json | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value !== "string") return null;
  const text = value.trim().replace(/,(?=\d{3}\b)/g, "");
  if (!/^\d{1,9}(\.\d{1,4})?$/.test(text)) return null;
  return Number(text);
}

function currencyCode(value: Json | undefined): string | null {
  const text = typeof value === "string" ? value.trim().toUpperCase() : "";
  return /^[A-Z]{3}$/.test(text) ? text : null;
}

/** "35", "29.50": whole amounts without pence. */
function amountText(amount: number): string {
  return Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
}

/** "£35", "€12.50", or "35 SEK" for other currencies; just the amount with no currency. */
export function formatPrice(amount: number, currency: string | null): string {
  const symbol = currency ? CURRENCY_SYMBOLS[currency] : undefined;
  if (symbol) return `${symbol}${amountText(amount)}`;
  return currency ? `${amountText(amount)} ${currency}` : amountText(amount);
}

function formatRange(low: number, high: number, currency: string | null): string {
  return low === high ? formatPrice(low, currency) : `${formatPrice(low, currency)} - ${formatPrice(high, currency)}`;
}

/** The price of one schema.org Offer or AggregateOffer, or null. */
function offerPrice(offer: JsonObject, fallbackCurrency: string | null): string | null {
  const spec = asArray(offer.priceSpecification).find(isObject);
  const currency = currencyCode(offer.priceCurrency) ?? (spec ? currencyCode(spec.priceCurrency) : null) ?? fallbackCurrency;
  const price = parseAmount(offer.price) ?? (spec ? parseAmount(spec.price) : null);
  if (price !== null) return formatPrice(price, currency);
  const low = parseAmount(offer.lowPrice);
  const high = parseAmount(offer.highPrice);
  if (low !== null && high !== null && low <= high) return formatRange(low, high, currency);
  if (low !== null) return formatPrice(low, currency);
  return null;
}

function fromJsonLd(jsonLd: readonly string[]): string | null {
  const documents = jsonLd.map(parseJsonLd).filter((d): d is Json => d !== null);
  for (const product of findProductNodes(documents)) {
    const variants = asArray(product.hasVariant).filter(isObject);
    const offers = [product, ...variants].flatMap((node) => asArray(node.offers)).filter(isObject).slice(0, MAX_OFFERS);
    for (const offer of offers) {
      const price = offerPrice(offer, null);
      if (price) return price;
    }
  }
  return null;
}

function metaValue(meta: readonly MetaTag[], keys: readonly string[]): string | null {
  for (const key of keys) {
    const tag = meta.find((t) => t.key === key && t.content.trim());
    if (tag) return tag.content;
  }
  return null;
}

function fromMeta(meta: readonly MetaTag[]): string | null {
  const amount = parseAmount(metaValue(meta, ["product:price:amount", "og:price:amount", "product:sale_price:amount"]));
  if (amount === null) return null;
  return formatPrice(amount, currencyCode(metaValue(meta, ["product:price:currency", "og:price:currency", "product:sale_price:currency"])));
}

/** The page's price as display text, or null if it doesn't say. */
export function parseProductPrice(html: string): string | null {
  const parts = extractPageParts(html);
  return fromJsonLd(parts.jsonLd) ?? fromMeta(parts.meta);
}
