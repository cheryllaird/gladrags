/**
 * Reading the product out of a shop's page: schema.org Product JSON-LD
 * first (including @graph containers, arrays and nesting), then Open Graph
 * meta tags for anything still missing.
 *
 * Everything here is untrusted. Text goes through the contract's
 * LinkProductSchema (single line, length-limited, blanks to null), and
 * image URLs must be absolute http(s) links once resolved against the page.
 */
import { LinkProductSchema, type LinkProduct } from "@/contracts";
import { MAX_URL_LENGTH } from "./url-policy";
import { decodeEntities, extractPageParts, type MetaTag } from "./html";

/** How many image URLs to keep, in order of preference. */
export const MAX_IMAGE_CANDIDATES = 5;

/** Limits on walking JSON-LD, so a hostile page can't make us loop for long. */
const MAX_JSON_LD_BYTES = 512 * 1024;
const MAX_NODES = 2000;
const MAX_DEPTH = 12;

export interface ParsedProductPage {
  /** True if the page has a schema.org Product, or Open Graph that describes a product. */
  hasProductData: boolean;
  product: LinkProduct;
  /** Absolute http(s) image URLs, best first, de-duplicated. */
  imageUrls: string[];
  /** Where the data came from, for logs and tests. */
  sources: ("json-ld" | "open-graph")[];
}

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

function isObject(value: Json | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: Json | undefined): Json[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Strip control and bidi-override characters that have no business in a product name. */
function cleanText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, " ");
}

/** The first non-empty string among the values, reading {name} / {@value} objects too. */
function firstText(value: Json | undefined, keys: readonly string[] = ["name", "@value"]): string | null {
  for (const entry of asArray(value)) {
    if (typeof entry === "string" && entry.trim()) return entry;
    if (typeof entry === "number") return String(entry);
    if (isObject(entry)) {
      for (const key of keys) {
        const text = firstText(entry[key], []);
        if (text) return text;
      }
    }
  }
  return null;
}

/** Image URLs from a schema.org `image` value: strings, ImageObjects ({url} / {contentUrl}), or arrays of either. */
function imageValues(value: Json | undefined): string[] {
  const urls: string[] = [];
  for (const entry of asArray(value)) {
    if (typeof entry === "string") urls.push(entry);
    else if (isObject(entry)) {
      const url = firstText(entry.url, []) ?? firstText(entry.contentUrl, []);
      if (url) urls.push(url);
    }
  }
  return urls;
}

function typesOf(node: JsonObject): string[] {
  return asArray(node["@type"])
    .filter((t): t is string => typeof t === "string")
    .map((t) => t.replace(/^https?:\/\/schema\.org\//i, "").toLowerCase());
}

const PRODUCT_TYPES = new Set(["product", "productgroup", "individualproduct", "productmodel", "someproducts"]);

/**
 * Remove wrappers some sites put around JSON-LD (HTML comments, CDATA) and
 * parse it. Returns null for anything that isn't valid JSON.
 */
export function parseJsonLd(raw: string): Json | null {
  if (raw.length > MAX_JSON_LD_BYTES) return null;
  const text = raw
    .trim()
    .replace(/^<!--/, "")
    .replace(/-->$/, "")
    .replace(/^\/\/\s*<!\[CDATA\[/, "")
    .replace(/\/\/\s*\]\]>$/, "")
    .replace(/^<!\[CDATA\[/, "")
    .replace(/\]\]>$/, "")
    .trim();
  try {
    return JSON.parse(text) as Json;
  } catch {
    return null;
  }
}

/** Every Product node in a JSON-LD document, outermost first. Bounded in size and depth. */
export function findProductNodes(documents: readonly Json[]): JsonObject[] {
  const products: JsonObject[] = [];
  let visited = 0;
  const visit = (value: Json, depth: number) => {
    if (depth > MAX_DEPTH || visited >= MAX_NODES) return;
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, depth + 1);
      return;
    }
    if (!isObject(value)) return;
    visited++;
    if (typesOf(value).some((t) => PRODUCT_TYPES.has(t))) products.push(value);
    for (const [key, child] of Object.entries(value)) {
      // @graph is the usual container; mainEntity, itemListElement, hasVariant
      // and friends nest products too. @context is never data.
      if (key === "@context") continue;
      if (typeof child === "object" && child !== null) visit(child, depth + 1);
    }
  };
  for (const document of documents) visit(document, 0);
  return products;
}

interface RawProduct {
  title: string | null;
  brand: string | null;
  colour: string | null;
  images: string[];
}

/**
 * JSON-LD is raw text in HTML, so entities aren't decoded by the browser
 * either; but many shops' CMSs encode them anyway ("Hartley &amp; Lowe").
 */
function decoded(text: string | null | undefined): string | null {
  return text ? decodeEntities(text) : null;
}

function fromJsonLd(node: JsonObject): RawProduct {
  const variants = asArray(node.hasVariant).filter(isObject);
  return {
    title: decoded(firstText(node.name)),
    brand: decoded(firstText(node.brand) ?? firstText(node.manufacturer)),
    colour: decoded(firstText(node.color) ?? variants.map((v) => firstText(v.color)).find(Boolean)),
    images: [...imageValues(node.image), ...variants.flatMap((v) => imageValues(v.image))].map(decodeEntities),
  };
}

function metaValues(meta: readonly MetaTag[], keys: readonly string[]): string[] {
  const values: string[] = [];
  for (const key of keys) {
    for (const tag of meta) if (tag.key === key && tag.content.trim()) values.push(tag.content);
  }
  return values;
}

function fromOpenGraph(meta: readonly MetaTag[]): RawProduct & { isProduct: boolean } {
  const ogType = metaValues(meta, ["og:type"])[0]?.trim().toLowerCase() ?? "";
  const productTags = meta.some((tag) => tag.key.startsWith("product:") || tag.key.startsWith("og:price") || tag.key === "og:brand");
  return {
    title: metaValues(meta, ["og:title", "twitter:title"])[0] ?? null,
    brand: metaValues(meta, ["product:brand", "og:brand", "brand"])[0] ?? null,
    colour: metaValues(meta, ["product:color", "product:colour", "og:color"])[0] ?? null,
    images: metaValues(meta, ["og:image:secure_url", "og:image", "og:image:url", "twitter:image", "twitter:image:src"]),
    isProduct: ogType.startsWith("product") || productTags,
  };
}

/** Resolve against the page and keep only plain absolute http(s) URLs. */
function imageUrl(raw: string, pageUrl: URL): string | null {
  const trimmed = cleanText(raw).trim();
  if (!trimmed || trimmed.length > MAX_URL_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(trimmed, pageUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  url.hash = "";
  return url.href.length > MAX_URL_LENGTH ? null : url.href;
}

/**
 * What relative URLs resolve against: the page's <base href> (itself
 * resolved against the page) when it's an http(s) URL, otherwise the page.
 * Images still have to be absolute http(s) after resolving, and every one
 * is fetched through the same SSRF checks as the page.
 */
function documentBase(baseHref: string | undefined, pageUrl: URL): URL {
  if (!baseHref || baseHref.length > MAX_URL_LENGTH) return pageUrl;
  try {
    const base = new URL(cleanText(baseHref).trim(), pageUrl);
    return base.protocol === "http:" || base.protocol === "https:" ? base : pageUrl;
  } catch {
    return pageUrl;
  }
}

/** Contract-clean text, or null if it doesn't pass. Each field stands alone. */
function cleanProduct(raw: Pick<RawProduct, "title" | "brand" | "colour">): LinkProduct {
  const field = (key: "title" | "brand" | "colour") => {
    const value = raw[key];
    const parsed = LinkProductSchema.shape[key].safeParse(value === null ? null : cleanText(value));
    return parsed.success ? parsed.data : null;
  };
  return { title: field("title"), brand: field("brand"), colour: field("colour") };
}

/**
 * Read a product page. `pageUrl` is where the page was finally fetched from
 * (after redirects), for resolving relative image URLs.
 */
export function parseProductPage(html: string, pageUrl: URL): ParsedProductPage {
  const parts = extractPageParts(html);
  const documents = parts.jsonLd.map(parseJsonLd).filter((d): d is Json => d !== null);
  const products = findProductNodes(documents).map(fromJsonLd);
  // The first product with a name is usually the page's main product.
  const main = products.find((p) => p.title) ?? products[0];
  const og = fromOpenGraph(parts.meta);

  const sources: ParsedProductPage["sources"] = [];
  if (main) sources.push("json-ld");
  // Open Graph alone counts as product data when it says it's a product,
  // or at least has a title and an image (most shops' pages).
  const ogUsable = og.isProduct || (og.title !== null && og.images.length > 0);
  if (ogUsable) sources.push("open-graph");

  const product = cleanProduct({
    title: main?.title ?? (ogUsable ? og.title : null),
    brand: main?.brand ?? (ogUsable ? og.brand : null),
    colour: main?.colour ?? (ogUsable ? og.colour : null),
  });

  const base = documentBase(parts.baseHref, pageUrl);
  const rawImages = [...(main?.images ?? []), ...(ogUsable ? og.images : [])];
  const imageUrls: string[] = [];
  for (const raw of rawImages) {
    const url = imageUrl(raw, base);
    if (url && !imageUrls.includes(url)) imageUrls.push(url);
    if (imageUrls.length >= MAX_IMAGE_CANDIDATES) break;
  }

  return { hasProductData: sources.length > 0, product, imageUrls, sources };
}
