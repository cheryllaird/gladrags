"use client";

import { useCallback, useEffect, useState } from "react";
import type { UsageSummary } from "@/contracts";
import { getUsage } from "@/lib/client/api";

/**
 * Today's item count and whether AI is paused (GET /api/usage), so the add
 * screens can warn before the user takes a photo. Null until loaded, or if
 * it couldn't be loaded (the upload itself still enforces the caps).
 */
export function useUsage(): { usage: UsageSummary | null; refresh: () => void } {
  const [usage, setUsage] = useState<UsageSummary | null>(null);

  const refresh = useCallback(() => {
    getUsage().then(setUsage, () => setUsage(null));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { usage, refresh };
}

/** Why adding is blocked right now, if it is. */
export function addingBlockedBy(usage: UsageSummary | null): "paused" | "cap" | null {
  if (!usage) return null;
  if (usage.aiPaused) return "paused";
  if (usage.itemsToday.used >= usage.itemsToday.limit) return "cap";
  return null;
}
