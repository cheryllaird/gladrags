/**
 * Reading an inbound email service's authentication and spam results out
 * of the headers it adds (CONTRACTS.md section 5, "Order emails", step 1:
 * `auth.spf`, `auth.spfDomain`, `auth.dkim`, `auth.dkimDomains`,
 * `auth.dmarc`, `spam`).
 *
 * Headers are untrusted. Anyone can write "Authentication-Results:
 * dmarc=pass" or "Received-SPF: pass" into an email they send, so:
 * - Results are read only from the receiving service's OWN block of
 *   headers (`serviceHeaderBlock`): everything above the second `Received`
 *   header. The first `Received` is the service's local delivery, the
 *   second its SMTP receipt from the outside world; everything below that
 *   came with the message.
 * - Authentication-Results is only read when its authserv-id (the first
 *   field) is one the app was told to trust (the receiving service's own).
 * - A DKIM-Signature header on its own proves nothing (anyone can add one),
 *   so signing domains only come from a trusted DKIM pass.
 * - The envelope sender inside Received-SPF is the attacker's to choose
 *   (SMTP allows a quoted local part with almost anything in it), so these
 *   headers are read with a small tokenizer that respects quoted strings
 *   and comments, never with "find the first key=" regexes.
 *
 * The results are lower-cased words; the contract maps anything it doesn't
 * know (temperror, permerror, ...) to "unknown", which is refused.
 */
export interface EmailHeader {
  name: string;
  value: string;
}

export interface AuthResults {
  spf: string | null;
  spfDomain: string | null;
  dkim: string | null;
  dkimDomains: string[];
  dmarc: string | null;
}

// ---------------------------------------------------------------------------
// Which headers are the service's own
// ---------------------------------------------------------------------------

/**
 * The headers the receiving service added itself: everything above the
 * SECOND `Received` header (the first is its local delivery, the second
 * its SMTP receipt of the message; anything below that came with the
 * message and could be forged). Fails closed: with fewer than two
 * `Received` headers there's no block, so nothing is trusted.
 */
export function serviceHeaderBlock(headers: readonly EmailHeader[]): EmailHeader[] {
  let seen = 0;
  for (let i = 0; i < headers.length; i++) {
    if (headers[i]!.name.toLowerCase() === "received" && ++seen === 2) return headers.slice(0, i);
  }
  return [];
}

/** The first header with this exact name (case-insensitive), or undefined. */
export function firstHeader(headers: readonly EmailHeader[], name: string): string | undefined {
  const wanted = name.toLowerCase();
  return headers.find((h) => h.name.toLowerCase() === wanted)?.value;
}

// ---------------------------------------------------------------------------
// Tokenizing structured header values (RFC 5322 comments and quoted strings)
// ---------------------------------------------------------------------------

/**
 * Remove comments "(...)", nested ones included. A quoted string ("...")
 * is kept whole, both outside and inside a comment, so a ")" or "(" inside
 * quotes never opens or closes one; a backslash escapes the next character.
 */
export function stripComments(value: string): string {
  let out = "";
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const char = value[i]!;
    if (char === "\\" && (quoted || depth > 0)) {
      // Quoted pair: keep it verbatim outside comments.
      if (depth === 0) out += value.slice(i, i + 2);
      i++;
    } else if (quoted) {
      if (char === '"') quoted = false;
      if (depth === 0) out += char;
    } else if (char === '"') {
      quoted = true;
      if (depth === 0) out += char;
    } else if (char === "(") {
      depth++;
    } else if (char === ")" && depth > 0) {
      depth--;
    } else if (depth === 0) {
      out += char;
    }
  }
  return out;
}

/** Split on `separator` where it isn't inside a quoted string. Comments should already be stripped. */
export function splitOutsideQuotes(value: string, separator: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const char = value[i]!;
    if (char === "\\" && quoted) {
      current += value.slice(i, i + 2);
      i++;
    } else if (char === '"') {
      quoted = !quoted;
      current += char;
    } else if (char === separator && !quoted) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts;
}

export interface HeaderParam {
  /** Lower-cased. */
  key: string;
  /** Null for a bare word (e.g. the result in "pass identity=mailfrom"). Quoted parts are kept with their quotes. */
  value: string | null;
}

const KEY_CHAR = /[a-z0-9._-]/i;
const SPACE = /\s/;

/**
 * The words and `key=value` pairs in a comment-free header part, in order.
 * A value runs until whitespace or ";" outside quotes, so a quoted local
 * part ("x; y=z"@domain) stays inside its value. `key = value` with spaces
 * around "=" is read too (RFC 7208 allows it).
 */
export function readParams(text: string): HeaderParam[] {
  const params: HeaderParam[] = [];
  let i = 0;
  const skipSpace = () => {
    while (i < text.length && (SPACE.test(text[i]!) || text[i] === ";")) i++;
  };
  while (i < text.length) {
    skipSpace();
    if (i >= text.length) break;
    if (!KEY_CHAR.test(text[i]!)) {
      // Not a word: skip one token (up to whitespace or ";", respecting quotes).
      i = endOfValue(text, i);
      continue;
    }
    let key = "";
    while (i < text.length && KEY_CHAR.test(text[i]!)) key += text[i++];
    let j = i;
    while (j < text.length && SPACE.test(text[j]!)) j++;
    if (text[j] !== "=") {
      params.push({ key: key.toLowerCase(), value: null });
      continue;
    }
    i = j + 1;
    while (i < text.length && SPACE.test(text[i]!)) i++;
    const end = endOfValue(text, i);
    params.push({ key: key.toLowerCase(), value: text.slice(i, end) });
    i = end;
  }
  return params;
}

/** Index just past a value starting at `start`: whitespace or ";" ends it, except inside quotes. */
function endOfValue(text: string, start: number): number {
  let i = start;
  let quoted = false;
  while (i < text.length) {
    const char = text[i]!;
    if (quoted) {
      if (char === "\\") i++;
      else if (char === '"') quoted = false;
    } else if (char === '"') {
      quoted = true;
    } else if (SPACE.test(char) || char === ";") {
      break;
    }
    i++;
  }
  return i;
}

/**
 * The domain of an address (`local@domain`, `<local@domain>`, `@domain`)
 * or a bare domain, lower-cased, or null. The "@" that counts is the last
 * one OUTSIDE quotes, so a quoted local part can't supply the domain.
 */
export function domainOf(value: string | undefined | null): string | null {
  if (!value) return null;
  const trimmed = unquoteWhole(value.trim()).replace(/^<(.*)>$/s, "$1").trim();
  let at = -1;
  let quoted = false;
  for (let i = 0; i < trimmed.length; i++) {
    const char = trimmed[i]!;
    if (quoted && char === "\\") i++;
    else if (char === '"') quoted = !quoted;
    else if (char === "@" && !quoted) at = i;
  }
  if (quoted) return null;
  const domain = (at >= 0 ? trimmed.slice(at + 1) : trimmed).toLowerCase().replace(/\.$/, "");
  return /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/.test(domain) ? domain : null;
}

/**
 * A parameter value that is one quoted string as a whole (as SPF milters
 * write `envelope-from="user@example.com"`), unquoted and unescaped. A
 * value that is only partly quoted ("x"@evil.example) is returned as it is,
 * so its quoted local part stays quoted.
 */
export function unquoteWhole(value: string): string {
  if (!value.startsWith('"')) return value;
  let out = "";
  for (let i = 1; i < value.length; i++) {
    const char = value[i]!;
    if (char === "\\" && i + 1 < value.length) {
      out += value[++i];
    } else if (char === '"') {
      // The closing quote must be the last character.
      return i === value.length - 1 ? out : value;
    } else {
      out += char;
    }
  }
  return value; // unterminated
}

/** Values of every param with this key. */
function valuesOf(params: readonly HeaderParam[], key: string): string[] {
  return params.filter((p) => p.key === key && p.value !== null).map((p) => p.value!);
}

// ---------------------------------------------------------------------------
// Received-SPF, Authentication-Results, spam
// ---------------------------------------------------------------------------

/**
 * Received-SPF (RFC 7208 section 9.1), e.g.
 * `Pass (sender SPF authorized) identity=mailfrom; client-ip=...;
 * envelope-from=user@example.com; receiver=...`.
 *
 * The domain is the envelope sender's (what DMARC aligns), and only for the
 * MAIL FROM identity: a HELO check says nothing about the sender. A header
 * with more than one `envelope-from` (or `identity`), or an envelope sender
 * with quotes, spaces or other oddities inside (envelopeDomain), gives no
 * domain, which fails safe (SPF can't then vouch for the From address).
 */
export function parseReceivedSpf(value: string | undefined): { result: string | null; domain: string | null } {
  if (!value) return { result: null, domain: null };
  const params = readParams(stripComments(value));
  const first = params[0];
  const result = first && first.value === null && /^[a-z]+$/.test(first.key) ? first.key : null;
  const envelopeFrom = valuesOf(params, "envelope-from");
  const identity = valuesOf(params, "identity");
  if (envelopeFrom.length !== 1 || identity.length > 1) return { result, domain: null };
  const isMailFrom = identity.length === 0 || identity[0]!.toLowerCase() === "mailfrom";
  // Quotes anywhere in the header, other than one pair wrapping the
  // envelope-from value, mean a quoted local part (refused) or a value the
  // tokenizer may have split wrongly: no domain.
  const quotes = (value.match(/"/g) ?? []).length;
  const wrapped = /^"[^"]*"$/.test(envelopeFrom[0]!.trim());
  if (quotes !== 0 && !(quotes === 2 && wrapped)) return { result, domain: null };
  return { result, domain: isMailFrom ? envelopeDomain(envelopeFrom[0]!) : null };
}

/**
 * The domain of an `envelope-from` value, refusing anything quoted inside
 * (orchestrator decision: real users don't have quoted local parts, and a
 * service that doesn't escape inner quotes makes them ambiguous, e.g.
 * `""x@mail.example;"@evil.example"`). The only quotes allowed are one
 * pair wrapping the whole value, with no quote or backslash inside.
 */
export function envelopeDomain(value: string): string | null {
  let address = value.trim();
  if (address.includes('"')) {
    const inner = address.slice(1, -1);
    if (!(address.length >= 2 && address.startsWith('"') && address.endsWith('"')) || inner.includes('"') || inner.includes("\\")) return null;
    address = inner;
  }
  if (/[\s;()\\<>"]/.test(address.replace(/^<(.*)>$/s, "$1"))) return null;
  // A real sender: a non-empty local part before the only "@".
  const bare = address.replace(/^<(.*)>$/s, "$1");
  const at = bare.indexOf("@");
  if (at < 1 || at !== bare.lastIndexOf("@")) return null;
  return domainOf(bare);
}

/**
 * One Authentication-Results header (RFC 8601), e.g.
 * `mx.example.net; spf=pass smtp.mailfrom=user@example.com;
 * dkim=pass header.d=example.com; dmarc=pass header.from=example.com`.
 * Null if its authserv-id isn't one of `trustedIds`.
 */
export function parseAuthenticationResults(value: string, trustedIds: readonly string[]): AuthResults | null {
  const [authservPart, ...methods] = splitOutsideQuotes(stripComments(value), ";");
  const authservId = authservPart?.trim().split(/\s+/)[0]?.toLowerCase().replace(/\.$/, "");
  if (!authservId || !trustedIds.some((id) => id.toLowerCase().replace(/\.$/, "") === authservId)) return null;

  const results: AuthResults = { spf: null, spfDomain: null, dkim: null, dkimDomains: [], dmarc: null };
  for (const method of methods) {
    const [head, ...props] = readParams(method);
    if (!head || head.value === null || !/^[a-z]+$/i.test(head.value)) continue;
    const name = head.key;
    const result = head.value.toLowerCase();
    const prop = (key: string) => {
      const values = valuesOf(props, key);
      return values.length === 1 ? values[0] : undefined;
    };
    if (name === "spf" && results.spf === null) {
      results.spf = result;
      results.spfDomain = domainOf(prop("smtp.mailfrom"));
    } else if (name === "dkim") {
      // Several signatures: "pass" if any passed, with the domains that did.
      if (result === "pass") {
        const domain = domainOf(prop("header.d") ?? prop("header.i"));
        if (domain && !results.dkimDomains.includes(domain)) results.dkimDomains.push(domain);
        results.dkim = "pass";
      } else if (results.dkim !== "pass") {
        results.dkim = result;
      }
    } else if (name === "dmarc" && results.dmarc === null) {
      results.dmarc = result;
    }
  }
  return results;
}

/** The first trusted Authentication-Results header's results, or null if there's none. Pass the service's own block. */
export function trustedAuthenticationResults(headers: readonly EmailHeader[], trustedIds: readonly string[]): AuthResults | null {
  if (trustedIds.length === 0) return null;
  for (const header of headers) {
    if (header.name.toLowerCase() !== "authentication-results") continue;
    const parsed = parseAuthenticationResults(header.value, trustedIds);
    if (parsed) return parsed;
  }
  return null;
}

/**
 * SpamAssassin's verdict from X-Spam-Status / X-Spam-Score (what Postmark
 * adds), e.g. `X-Spam-Status: No` and `X-Spam-Score: -0.1`. Pass the
 * service's own block: a verdict missing there reads as unknown, never as
 * one from lower down.
 */
export function parseSpamHeaders(headers: readonly EmailHeader[]): { isSpam: boolean | null; score: number | null } {
  const status = firstHeader(headers, "X-Spam-Status");
  const scoreText = firstHeader(headers, "X-Spam-Score");
  const word = status ? /^\s*(yes|no)\b/i.exec(status)?.[1]?.toLowerCase() : undefined;
  const isSpam = word === "yes" ? true : word === "no" ? false : null;
  const score = scoreText !== undefined && /^\s*-?\d+(\.\d+)?\s*$/.test(scoreText) ? Number(scoreText) : null;
  return { isSpam, score };
}
