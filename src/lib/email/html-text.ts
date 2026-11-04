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
const DROPPED_ELEMENTS = new Set(["script", "style", "head", "title", "noscript", "template", "svg", "object", "iframe"]);

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
  return flatten(decodeEntities(raw).replace(/[\r\n]+/g, " "));
}

const TAG_NAME = /^[a-zA-Z][a-zA-Z0-9-]*/;

/**
 * The HTML as text: one block per line, `[link: URL]` after a link's
 * words and `[image: ALT URL]` for each picture.
 *
 * One forward scan, so hostile HTML (thousands of unclosed "<script" or
 * "<!--") costs linear time: every search starts where the last one
 * ended, and anything left unclosed drops the rest of the email.
 */
export function htmlToText(html: string): string {
  const lower = html.toLowerCase();
  const out: string[] = [];
  const pendingLinks: string[] = [];
  // `i`: where the current run of text started; `from`: where to look for the next "<".
  let i = 0;
  let from = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", from);
    if (lt < 0) {
      out.push(inlineText(html.slice(i)));
      break;
    }
    const next = html[lt + 1];
    const closing = next === "/";
    const isMarkup = next === "!" || next === "?";
    const nameMatch = isMarkup ? null : TAG_NAME.exec(html.slice(lt + (closing ? 2 : 1), lt + (closing ? 2 : 1) + 64));
    if (!isMarkup && !nameMatch) {
      // A "<" that doesn't start a tag is just text: keep scanning the same run.
      from = lt + 1;
      continue;
    }
    out.push(inlineText(html.slice(i, lt)));

    // Comments, CDATA, <!DOCTYPE ...> and <?xml ...?>: skipped whole.
    const skipTo = (closer: string, from: number) => {
      const at = html.indexOf(closer, from);
      return at < 0 ? html.length : at + closer.length;
    };
    if (html.startsWith("<!--", lt)) {
      i = from = skipTo("-->", lt + 4);
      continue;
    }
    if (html.startsWith("<![CDATA[", lt)) {
      i = from = skipTo("]]>", lt + 9);
      continue;
    }
    if (isMarkup || !nameMatch) {
      i = from = skipTo(">", lt + 2);
      continue;
    }

    const tagEnd = html.indexOf(">", lt);
    if (tagEnd < 0) break; // an unclosed tag: drop the rest
    const tag = html.slice(lt, tagEnd + 1);
    const name = nameMatch[0].toLowerCase();
    i = from = tagEnd + 1;

    if (!closing && DROPPED_ELEMENTS.has(name)) {
      const close = lower.indexOf(`</${name}`, i);
      i = from = close < 0 ? html.length : skipTo(">", close);
      out.push(" ");
      continue;
    }
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
