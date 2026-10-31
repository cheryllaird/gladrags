/**
 * The first things the inbound webhook does with a request, before it
 * parses anything (CONTRACTS.md section 5, "Order emails", step 1): read
 * the body without letting it grow past the limit, and compare secrets in
 * constant time.
 */
import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";

/** The body was over the limit (by Content-Length, or as it arrived). */
export class BodyTooLargeError extends Error {
  constructor() {
    super("Request body too large");
    this.name = "BodyTooLargeError";
  }
}

/**
 * The raw body, refusing more than `maxBytes` without buffering it all: a
 * Content-Length over the limit is refused before reading anything, then
 * the stream is read with a running byte count that stops at the limit
 * (Content-Length can be missing or wrong).
 */
export async function readBodyCapped(request: Request, maxBytes: number): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (declared !== null && /^\s*\d+\s*$/.test(declared) && Number(declared) > maxBytes) throw new BodyTooLargeError();
  if (!request.body) return new Uint8Array(0);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new BodyTooLargeError();
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/**
 * True if the two strings are equal, taking the same time whatever they
 * hold. Both are hashed first, so their lengths don't leak either
 * (timingSafeEqual needs equal-length inputs).
 */
export function secretsEqual(given: string, expected: string): boolean {
  const a = createHash("sha256").update(given, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  // Hashes of different strings can't collide in practice; the length
  // check is belt and braces for the empty-string case.
  return timingSafeEqual(a, b) && given.length === expected.length;
}
