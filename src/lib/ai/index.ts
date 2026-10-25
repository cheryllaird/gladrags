import { createGeminiRankingProvider } from "./gemini-ranking";
import type { RankingProvider, TaggingProvider } from "./types";

export * from "./types";
export { callWithValidation, type ValidatedCallResult, type CallWithValidationOptions } from "./validate";
export { FakeRankingProvider, FakeTaggingProvider } from "./fakes";

/**
 * Factories for the real providers. Foundations only defines the
 * interfaces: ingestion replaces getTaggingProvider with the Gemini
 * implementation and outfit-engine replaces getRankingProvider. Until then
 * they throw, so nothing silently pretends to work.
 */
export function getTaggingProvider(): TaggingProvider {
  throw new Error("No tagging provider yet: the ingestion agent adds the Gemini implementation.");
}

/** Gemini ranking (both passes). Throws ConfigError if GEMINI_API_KEY isn't set. */
export function getRankingProvider(): RankingProvider {
  return createGeminiRankingProvider();
}
