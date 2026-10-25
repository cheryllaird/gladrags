"use client";

import { useEffect, useRef } from "react";

/**
 * Item images are short-lived signed URLs (1 hour, CONTRACTS.md section 2).
 * A phone app stays open for hours, so screens that show items refetch
 * them, which signs fresh URLs:
 *
 * - when an image fails to load: once per load, and at most once every
 *   STALE_AFTER_MS, so an image that is broken for good can't loop;
 * - when the user comes back to the app and the data is older than
 *   STALE_AFTER_MS (a little under the hour, so it beats the expiry).
 */
export const STALE_AFTER_MS = 50 * 60 * 1000;

export function useSignedUrlRefresh({
  loadKey,
  loadedAt,
  refresh,
  now = Date.now,
}: {
  /** Identifies the current load; image errors from the same load refetch only once. */
  loadKey: string | null;
  /** When the current data arrived (Date.now()), or null while loading. */
  loadedAt: number | null;
  refresh: () => void;
  now?: () => number;
}): { onImageError: () => void } {
  const retriedLoad = useRef<string | null>(null);
  const lastImageRetry = useRef<number | null>(null);
  const latest = useRef({ loadedAt, refresh, now });
  useEffect(() => {
    latest.current = { loadedAt, refresh, now };
  });

  useEffect(() => {
    function onVisible() {
      if (document.visibilityState !== "visible") return;
      const { loadedAt, refresh, now } = latest.current;
      if (loadedAt !== null && now() - loadedAt > STALE_AFTER_MS) refresh();
    }
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  function onImageError() {
    const { refresh, now } = latest.current;
    if (loadKey === null || retriedLoad.current === loadKey) return;
    if (lastImageRetry.current !== null && now() - lastImageRetry.current < STALE_AFTER_MS) return;
    retriedLoad.current = loadKey;
    lastImageRetry.current = now();
    refresh();
  }

  return { onImageError };
}
