/**
 * Mock-mode markers, so the UI (and e2e tests) can trigger the fallback
 * and error states on purpose. Put the marker text in:
 * - add by photo: the original file's name, e.g. "shirt-mock-no-tags.jpg"
 * - add by link: anywhere in the URL, e.g. https://shop.example.com/p?x=mock-ai-paused
 * - outfits: the guidance, the custom style text, or refine guidance
 *
 * Only the mock routes look for these. See docs/CONTRACTS.md, section 1.
 */
import type { CapKind, CappedAction } from "@/contracts";
import { DAILY_CAPS, MONTHLY_AI_SPEND_CAP_PENCE, USAGE_TIME_ZONE } from "@/lib/usage/config";
import { CapReachedError } from "@/lib/usage/errors";
import { startOfNextDay, startOfNextMonth } from "@/lib/usage/time";

export const MOCK_MARKERS = {
  /** Tagging "fails twice": the draft comes back with suggestedTags: null. */
  noTags: "mock-no-tags",
  /** 503 ai_paused, as if the monthly AI spend cap were reached. */
  aiPaused: "mock-ai-paused",
  /** 429 daily_cap_reached, as if today's cap for this action were used up. */
  dailyCap: "mock-daily-cap",
  /** Outfits: canned outfits with a shoes gap (as does includeShopItems: true). */
  gaps: "mock-gaps",
} as const;

const CAP_KIND_FOR_ACTION: Record<CappedAction, CapKind> = {
  item_ingest: "items_per_day",
  outfit_request: "outfit_requests_per_day",
  link_fetch: "link_fetches_per_day",
  email_import: "emails_per_day",
  shop_search: "shop_searches_per_day",
};

export function hasMarker(texts: readonly (string | null | undefined)[], marker: string): boolean {
  return texts.some((text) => text?.toLowerCase().includes(marker));
}

/** Throw the cap error a marker asks for, if any. */
export function throwIfCapMarker(texts: readonly (string | null | undefined)[], action: CappedAction): void {
  const now = new Date();
  if (hasMarker(texts, MOCK_MARKERS.aiPaused)) {
    throw new CapReachedError("monthly_ai_spend", MONTHLY_AI_SPEND_CAP_PENCE, startOfNextMonth(now, USAGE_TIME_ZONE));
  }
  if (hasMarker(texts, MOCK_MARKERS.dailyCap)) {
    const cap = CAP_KIND_FOR_ACTION[action];
    throw new CapReachedError(cap, DAILY_CAPS[action], startOfNextDay(now, USAGE_TIME_ZONE));
  }
}
