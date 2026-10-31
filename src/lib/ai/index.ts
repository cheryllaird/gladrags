import { createGeminiRankingProvider } from "./gemini-ranking";
import { createGeminiTaggingProvider } from "./gemini-tagging";
import type { RankingProvider, TaggingProvider } from "./types";

export * from "./types";
export { canTagFromText } from "./tagging-input";
export { callWithValidation, type ValidatedCallResult, type CallWithValidationOptions } from "./validate";
export { FakeOrderEmailProvider, FakeRankingProvider, FakeShopSearchProvider, FakeTaggingProvider } from "./fakes";

/** Gemini tagging. Throws ConfigError if GEMINI_API_KEY isn't set. */
export function getTaggingProvider(): TaggingProvider {
  return createGeminiTaggingProvider();
}

/** Gemini ranking (both passes). Throws ConfigError if GEMINI_API_KEY isn't set. */
export function getRankingProvider(): RankingProvider {
  return createGeminiRankingProvider();
}
