/**
 * In-memory dependencies for ingestion tests: real image processing
 * (sharp), in-memory storage and items, a fake tagger with recorded
 * outputs, and a real UsageGuard on an in-memory store. No network.
 */
import type { UsageLimits } from "@/lib/usage/guard";
import { FakeTaggingProvider } from "@/lib/ai/fakes";
import type { TaggingProvider } from "@/lib/ai/types";
import { SharpImageProcessor } from "@/lib/images/sharp-processor";
import { UsageGuard } from "@/lib/usage/guard";
import { InMemoryUsageStore } from "@/lib/usage/store";
import { InMemoryItemRepository } from "@/lib/ingestion/items-repository";
import { InMemoryImageStorage } from "@/lib/ingestion/storage";

export const TEST_USER = "0c000000-0000-4000-8000-000000000003";
export const OTHER_USER = "0b000000-0000-4000-8000-000000000002";

export const TEST_LIMITS: UsageLimits = {
  dailyCaps: { item_ingest: 3, outfit_request: 2, link_fetch: 20 },
  monthlySpendCapPence: 1,
  timeZone: "Europe/London",
};

export function makeTestDeps({ taggerOutputs = [] as unknown[], tagger }: { taggerOutputs?: unknown[]; tagger?: TaggingProvider } = {}) {
  let now = new Date("2026-10-25T10:00:00Z");
  const clock = () => now;
  const usageStore = new InMemoryUsageStore(clock);
  const fake = new FakeTaggingProvider(taggerOutputs.length ? taggerOutputs : ["{}"]);
  return {
    images: new SharpImageProcessor(),
    storage: new InMemoryImageStorage(clock),
    items: new InMemoryItemRepository(clock),
    tagger: tagger ?? fake,
    fakeTagger: fake,
    usage: new UsageGuard(usageStore, TEST_LIMITS, clock),
    usageStore,
    setNow: (iso: string) => (now = new Date(iso)),
  };
}
