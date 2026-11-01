/**
 * Turning an order email into the plain text the model reads
 * (CONTRACTS.md section 5, "Order emails", step 5): HTML becomes text with
 * product and image links kept, so the model can return `productUrl` and
 * `imageUrl` for each line. Only http(s) links are kept; scripts, styles,
 * comments and everything in <head> are dropped.
 *
 * The result is for a prompt, not for display, so it doesn't need to look
 * like the email: it needs the words in order, one block per line, and the
 * links next to the words they belong to.
 */
import { EMAIL_PROMPT_TEXT_MAX } from "@/contracts";
import { decodeEntities } from "@/lib/link-import/html";

/** Longest link kept; tracking links can be long, but not this long. */
const MAX_LINK_LENGTH = 2048;

/** Elements whose contents are never text the reader sees. */
const DROPPED_ELEMENTS = /<(script|style|head|title|noscript|template|svg|object|iframe)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;

/** Tags that start a new line. */
const BLOCK_TAGS = /^(p|div|br|tr|li|ul|ol|table|tbody|thead|tfoot|h[1-6]|section|article|header|footer|blockquote|hr|center|dl|dt|dd|pre)$/i;

/** Read one attribute's value out of a start tag. */
function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\`]+))`, "i").exec(tag);
  if (!match) return null;
  return decodeEntities(match[1] ?? match[2] ?? match[3] ?? "").trim();
}

/** An absolute http(s) link without spaces, or null. */
function usableLink(value: string | null): string | null {
  if (!value || value.length > MAX_LINK_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  return url.href;
}

/** Make text one line: control and bidi characters out, whitespace collapsed. */
function flatten(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, " ")
    .replace(/[ \t ]+/g, " ");
}

/** Text between tags: entities decoded, HTML's own line breaks are just spaces. */
function inlineText(raw: string): string {
  return flatten(decodeEntities(raw.replace(/<[^>]*$/, "")).replace(/[\r\n]+/g, " "));
}

/**
 * The HTML as text: one block per line, `[link: URL]` after a link's
 * words and `[image: ALT URL]` for each picture.
 */
export function htmlToText(html: string): string {
  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, " ").replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, " ")
    // <!DOCTYPE ...> and <?xml ...?> declarations.
    .replace(/<[!?][^>]*>/g, " ");
  const withoutHidden = withoutComments.replace(DROPPED_ELEMENTS, " ");

  const out: string[] = [];
  const pendingLinks: string[] = [];
  const tagPattern = /<\/?([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>/g;
  let last = 0;
  for (const match of withoutHidden.matchAll(tagPattern)) {
    out.push(inlineText(withoutHidden.slice(last, match.index)));
    last = match.index + match[0].length;
    const tag = match[0];
    const name = match[1]!.toLowerCase();
    const closing = tag.startsWith("</");

    if (name === "a" && !closing) {
      const href = usableLink(attribute(tag, "href"));
      if (href) pendingLinks.push(href);
    } else if (name === "a" && closing) {
      const href = pendingLinks.pop();
      if (href) out.push(` [link: ${href}] `);
    } else if (name === "img" && !closing) {
      const src = usableLink(attribute(tag, "src"));
      if (src) {
        const alt = flatten(attribute(tag, "alt") ?? "").trim();
        out.push(` [image: ${alt ? `${alt} ` : ""}${src}] `);
      }
    } else if (name === "td" || name === "th") {
      out.push(" | ");
    } else if (BLOCK_TAGS.test(name)) {
      out.push("\n");
    }
  }
  out.push(inlineText(withoutHidden.slice(last)));

  return tidy(out.join(""));
}

/** Trim each line, drop empty ones and table pipes with nothing around them. */
function tidy(text: string): string {
  return text
    .split("\n")
    .map((line) =>
      line
        .replace(/(\s*\|\s*)+/g, " | ")
        .replace(/^\s*\|\s*|\s*\|\s*$/g, "")
        .replace(/ {2,}/g, " ")
        .trim(),
    )
    .filter((line) => line !== "")
    .join("\n");
}

/**
 * The text the model reads for an email: the HTML converted (it carries
 * the product and image links), or the plain-text body when there's no
 * HTML. Cut to EMAIL_PROMPT_TEXT_MAX characters, without splitting a
 * surrogate pair. Empty string if the email has neither.
 */
export function emailTextForModel(email: { text: string | null; html: string | null }, max = EMAIL_PROMPT_TEXT_MAX): string {
  const fromHtml = email.html ? htmlToText(email.html) : "";
  const text = fromHtml.trim() !== "" ? fromHtml : tidy(flatten((email.text ?? "").replace(/\r\n?/g, "\n")));
  if (text.length <= max) return text;
  let cut = text.slice(0, max);
  // A cut between a high and low surrogate leaves half an emoji.
  if (/[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1);
  return cut;
}
