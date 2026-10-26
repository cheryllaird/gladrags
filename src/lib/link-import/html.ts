/**
 * Just enough HTML reading for product pages: the <meta> tags (Open Graph
 * and friends) and the JSON-LD <script> blocks. Pages are untrusted, so
 * this never runs anything, uses no backtracking-prone regular expressions
 * over the whole page, and caps how much it collects.
 *
 * Deliberately not a full HTML parser: a page that hides its product data
 * somewhere this misses just gets the screenshot fallback.
 */

export interface MetaTag {
  /** Lower-cased `property` or `name` (or `itemprop`). */
  key: string;
  content: string;
}

export interface PageParts {
  meta: MetaTag[];
  /** Raw text of each <script type="application/ld+json"> block. */
  jsonLd: string[];
  /** The first <base href>, unresolved and unchecked. */
  baseHref?: string;
}

const MAX_META_TAGS = 500;
const MAX_JSON_LD_BLOCKS = 20;
const MAX_ATTRIBUTE_LENGTH = 4096;

// A Map, so names like "constructor" or "__proto__" can't hit Object's prototype.
const NAMED_ENTITIES: ReadonlyMap<string, string> = new Map(Object.entries({
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  hellip: "…",
  eacute: "é",
  egrave: "è",
  euml: "ë",
  uuml: "ü",
  ouml: "ö",
  auml: "ä",
  ccedil: "ç",
  reg: "®",
  trade: "™",
  copy: "©",
  pound: "£",
  euro: "€",
}));

/** Decode HTML character references. Unknown names are left as they are. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});?/gi, (whole, ref: string) => {
    if (ref[0] === "#") {
      const code = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      // No NUL, surrogates or out-of-range code points.
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "�";
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES.get(ref.toLowerCase()) ?? whole;
  });
}

/** Attributes of one start tag's inner text (after the tag name). Lower-cased names. */
export function parseAttributes(text: string): Map<string, string> {
  const attributes = new Map<string, string>();
  const pattern = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const match of text.matchAll(pattern)) {
    const name = match[1]!.toLowerCase();
    if (attributes.has(name)) continue; // HTML keeps the first
    const raw = match[2] ?? match[3] ?? match[4] ?? "";
    attributes.set(name, decodeEntities(raw.slice(0, MAX_ATTRIBUTE_LENGTH)));
  }
  return attributes;
}

/** Index of the `>` closing a tag that starts at `from`, honouring quoted attribute values. */
function tagEnd(html: string, from: number): number {
  let quote: string | null = null;
  for (let i = from; i < html.length; i++) {
    const c = html[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === ">") {
      return i;
    }
  }
  return -1;
}

/** Elements whose content is raw text: anything tag-like inside them isn't a tag. */
const RAW_TEXT_ELEMENTS = new Set(["script", "style", "textarea", "title", "noscript", "template", "iframe", "xmp"]);

/**
 * Walk the page's tags once, collecting meta tags and JSON-LD blocks.
 * Comments and the insides of script/style elements are skipped, so a
 * <meta> written inside a script string or a comment isn't read.
 */
export function extractPageParts(html: string): PageParts {
  const parts: PageParts = { meta: [], jsonLd: [] };
  const lower = html.toLowerCase();
  let i = 0;
  while (i < html.length) {
    const open = html.indexOf("<", i);
    if (open === -1) break;
    if (html.startsWith("<!--", open)) {
      const close = html.indexOf("-->", open + 4);
      i = close === -1 ? html.length : close + 3;
      continue;
    }
    const nameMatch = /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(html.slice(open, open + 40));
    if (!nameMatch) {
      i = open + 1;
      continue;
    }
    const name = nameMatch[1]!.toLowerCase();
    const end = tagEnd(html, open + nameMatch[0].length);
    if (end === -1) break;
    const attributeText = html.slice(open + nameMatch[0].length, end);

    // Like a browser: only the first <base> with an href counts.
    if (name === "base" && parts.baseHref === undefined) {
      const href = parseAttributes(attributeText).get("href")?.trim();
      if (href) parts.baseHref = href;
    }

    if (name === "meta" && parts.meta.length < MAX_META_TAGS) {
      const attributes = parseAttributes(attributeText);
      const key = (attributes.get("property") ?? attributes.get("name") ?? attributes.get("itemprop"))?.trim().toLowerCase();
      const content = attributes.get("content");
      if (key && content !== undefined) parts.meta.push({ key, content });
    }

    if (RAW_TEXT_ELEMENTS.has(name)) {
      const closeTag = lower.indexOf(`</${name}`, end + 1);
      const contentEnd = closeTag === -1 ? html.length : closeTag;
      if (name === "script" && parts.jsonLd.length < MAX_JSON_LD_BLOCKS) {
        // The media type, without parameters such as "; charset=utf-8".
        const type = parseAttributes(attributeText).get("type")?.split(";")[0]?.trim().toLowerCase();
        if (type === "application/ld+json") parts.jsonLd.push(html.slice(end + 1, contentEnd));
      }
      const afterClose = closeTag === -1 ? -1 : html.indexOf(">", closeTag);
      i = afterClose === -1 ? html.length : afterClose + 1;
      continue;
    }
    i = end + 1;
  }
  return parts;
}

/** The charset from a Content-Type header or a <meta charset> near the top of the page. */
export function detectCharset(contentType: string | null, head: Uint8Array): string {
  const fromHeader = contentType ? /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType)?.[1] : undefined;
  if (fromHeader) return fromHeader.toLowerCase();
  // Browsers look in the first 1024 bytes; be a little more generous.
  const start = new TextDecoder("latin1").decode(head.subarray(0, 4096));
  const fromMeta = /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(start)?.[1];
  return (fromMeta ?? "utf-8").toLowerCase();
}

/** Decode page bytes as text, falling back to UTF-8 for unknown charsets. */
export function decodeHtml(body: Uint8Array, contentType: string | null): string {
  const charset = detectCharset(contentType, body);
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charset);
  } catch {
    decoder = new TextDecoder("utf-8");
  }
  return decoder.decode(body);
}
