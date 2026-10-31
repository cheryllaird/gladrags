/**
 * Reading an inbound email service's authentication and spam results out
 * of the headers it adds (CONTRACTS.md section 5, "Order emails", step 1:
 * `auth.spf`, `auth.spfDomain`, `auth.dkim`, `auth.dkimDomains`,
 * `auth.dmarc`, `spam`).
 *
 * Headers are untrusted. Anyone can write "Authentication-Results:
 * dmarc=pass" into an email they send, so:
 * - Authentication-Results is only read when its authserv-id (the first
 *   field) is one the app was told to trust (the receiving service's own).
 * - Received-SPF and the spam headers are read from the TOP of the header
 *   list only: the receiving service adds its own above everything that
 *   came with the message.
 * - A DKIM-Signature header on its own proves nothing (anyone can add one),
 *   so signing domains only come from a trusted DKIM pass.
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

/** The domain part of an address (or a bare domain), lower-cased, or null. */
export function domainOf(value: string | undefined | null): string | null {
  if (!value) return null;
  const trimmed = value.trim().replace(/^<|>$/g, "");
  const at = trimmed.lastIndexOf("@");
  const domain = (at >= 0 ? trimmed.slice(at + 1) : trimmed).toLowerCase().replace(/\.$/, "");
  return /^[a-z0-9.-]+$/.test(domain) && domain.includes(".") ? domain : null;
}

/** Remove RFC 5322 comments "(...)", including nested ones. */
export function stripComments(value: string): string {
  let depth = 0;
  let out = "";
  for (const char of value) {
    if (char === "(") depth++;
    else if (char === ")" && depth > 0) depth--;
    else if (depth === 0) out += char;
  }
  return out;
}

/** The first header with this name (case-insensitive), or undefined. */
export function firstHeader(headers: readonly EmailHeader[], name: string): string | undefined {
  const wanted = name.toLowerCase();
  return headers.find((h) => h.name.toLowerCase() === wanted)?.value;
}

/** `key=value` pairs from a header body, keys lower-cased. Later duplicates are ignored. */
function keyValues(text: string): Map<string, string> {
  const pairs = new Map<string, string>();
  for (const match of text.matchAll(/([a-z][a-z0-9._-]*)\s*=\s*("([^"]*)"|[^\s;]+)/gi)) {
    const key = match[1]!.toLowerCase();
    if (!pairs.has(key)) pairs.set(key, match[3] ?? match[2]!);
  }
  return pairs;
}

/**
 * Received-SPF (RFC 7208 section 9.1), e.g.
 * `Pass (sender SPF authorized) identity=mailfrom; client-ip=...;
 * envelope-from=user@example.com; receiver=...`.
 * The domain is the envelope sender's (what DMARC aligns), and only for the
 * MAIL FROM identity: a HELO check says nothing about the sender.
 */
export function parseReceivedSpf(value: string | undefined): { result: string | null; domain: string | null } {
  if (!value) return { result: null, domain: null };
  const result = /^\s*([a-z]+)/i.exec(value)?.[1]?.toLowerCase() ?? null;
  const pairs = keyValues(stripComments(value));
  const identity = pairs.get("identity")?.toLowerCase();
  const domain = identity === undefined || identity === "mailfrom" ? domainOf(pairs.get("envelope-from")) : null;
  return { result, domain };
}

/**
 * One Authentication-Results header (RFC 8601), e.g.
 * `mx.example.net; spf=pass smtp.mailfrom=user@example.com;
 * dkim=pass header.d=example.com; dmarc=pass header.from=example.com`.
 * Null if its authserv-id isn't one of `trustedIds`.
 */
export function parseAuthenticationResults(value: string, trustedIds: readonly string[]): AuthResults | null {
  const [authservPart, ...methods] = stripComments(value).split(";");
  const authservId = authservPart?.trim().split(/\s+/)[0]?.toLowerCase().replace(/\.$/, "");
  if (!authservId || !trustedIds.some((id) => id.toLowerCase().replace(/\.$/, "") === authservId)) return null;

  const results: AuthResults = { spf: null, spfDomain: null, dkim: null, dkimDomains: [], dmarc: null };
  for (const method of methods) {
    const match = /^\s*([a-z-]+)\s*=\s*([a-z]+)/i.exec(method);
    if (!match) continue;
    const name = match[1]!.toLowerCase();
    const result = match[2]!.toLowerCase();
    const props = keyValues(method.slice(match[0].length));
    if (name === "spf" && results.spf === null) {
      results.spf = result;
      results.spfDomain = domainOf(props.get("smtp.mailfrom"));
    } else if (name === "dkim") {
      // Several signatures: "pass" if any passed, with the domains that did.
      if (result === "pass") {
        const domain = domainOf(props.get("header.d") ?? props.get("header.i"));
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

/** The first trusted Authentication-Results header's results, or null if there's none. */
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
 * SpamAssassin's verdict from the top X-Spam-Status / X-Spam-Score headers
 * (what Postmark adds), e.g. `X-Spam-Status: No` and `X-Spam-Score: -0.1`.
 */
export function parseSpamHeaders(headers: readonly EmailHeader[]): { isSpam: boolean | null; score: number | null } {
  const status = firstHeader(headers, "X-Spam-Status");
  const scoreText = firstHeader(headers, "X-Spam-Score");
  const word = status ? /^\s*(yes|no)\b/i.exec(status)?.[1]?.toLowerCase() : undefined;
  const isSpam = word === "yes" ? true : word === "no" ? false : null;
  const score = scoreText !== undefined && /^\s*-?\d+(\.\d+)?\s*$/.test(scoreText) ? Number(scoreText) : null;
  return { isSpam, score };
}
