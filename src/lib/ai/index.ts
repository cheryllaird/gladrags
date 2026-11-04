import { createGeminiOrderEmailProvider } from "./gemini-order-email";
import { createGeminiRankingProvider } from "./gemini-ranking";
import { createGeminiShopSearchProvider } from "./gemini-shop-search";
import { createGeminiTaggingProvider } from "./gemini-tagging";
import type { OrderEmailProvider, RankingProvider, ShopSearchProvider, TaggingProvider } from "./types";

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

/** Gemini with Google Search grounding, for "Find in my shops". Throws ConfigError if GEMINI_API_KEY isn't set. */
export function getShopSearchProvider(): ShopSearchProvider {
  return createGeminiShopSearchProvider();
}

/** Gemini reading order emails (text only). Throws ConfigError if GEMINI_API_KEY isn't set. */
export function getOrderEmailProvider(): OrderEmailProvider {
  return createGeminiOrderEmailProvider();
}
