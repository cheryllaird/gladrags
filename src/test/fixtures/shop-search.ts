/** Recorded-style grounded shop search replies (src/test/fixtures/gemini-shop-search/). Test-only. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DIR = fileURLToPath(new URL("./gemini-shop-search/", import.meta.url));

/** The reply text of a fixture, as Gemini would return it. */
export function shopSearchReply(name: string): string {
  return (JSON.parse(readFileSync(`${DIR}${name}.json`, "utf8")) as { text: string }).text;
}
