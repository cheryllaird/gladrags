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

export function getRankingProvider(): RankingProvider {
  throw new Error("No ranking provider yet: the outfit-engine agent adds the Gemini implementation.");
}
