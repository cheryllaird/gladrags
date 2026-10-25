/**
 * Records real Gemini replies for the ranking prompts. SKIPPED unless
 * GEMINI_RECORD=1, so `pnpm test` never calls Gemini. To re-record (a few
 * cheap calls; needs GEMINI_API_KEY):
 *
 *   GEMINI_RECORD=1 NODE_USE_ENV_PROXY=1 pnpm vitest run src/lib/ai/gemini-ranking.live.test.ts
 *
 * Each reply's text is saved to src/test/fixtures/gemini-ranking/<name>.json
 * and replayed by gemini-ranking.test.ts.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { GoogleGenAI, type GenerateContentParameters } from "@google/genai";
import { describe, it } from "vitest";
import {
  anchorInjectionShortlistInput,
  swapFinalInput,
  workFinalInput,
  workShortlistInput,
} from "@/test/fixtures/ranking-inputs";
import { GeminiRankingProvider, geminiModelFromEnv, type GeminiContentGenerator } from "./gemini-ranking";

const FIXTURE_DIR = fileURLToPath(new URL("../../test/fixtures/gemini-ranking/", import.meta.url));

describe.skipIf(process.env.GEMINI_RECORD !== "1")("record Gemini ranking replies (live)", () => {
  const model = geminiModelFromEnv();
  const client = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY!,
    httpOptions: { retryOptions: { attempts: 3, initialDelay: 2, maxDelay: 8 } },
  });

  function recorder(name: string): GeminiContentGenerator {
    return {
      async generateContent(params: GenerateContentParameters) {
        const response = await client.models.generateContent(params);
        mkdirSync(FIXTURE_DIR, { recursive: true });
        const recording = {
          model,
          recordedAt: new Date().toISOString(),
          usage: response.usageMetadata ?? null,
          text: response.text ?? null,
        };
        writeFileSync(`${FIXTURE_DIR}${name}.json`, `${JSON.stringify(recording, null, 2)}\n`);
        console.log(name, response.text, response.usageMetadata);
        return response;
      },
    };
  }

  const cases = [
    ["work-shortlist", (p: GeminiRankingProvider) => p.shortlist(workShortlistInput())],
    ["anchor-injection-shortlist", (p: GeminiRankingProvider) => p.shortlist(anchorInjectionShortlistInput())],
    ["work-final", (p: GeminiRankingProvider) => p.pickFinal(workFinalInput())],
    ["swap-final", (p: GeminiRankingProvider) => p.pickFinal(swapFinalInput())],
  ] as const;

  it.each(cases)("%s", async (name, run) => {
    await run(new GeminiRankingProvider(recorder(name), model));
  }, 60_000);
});
