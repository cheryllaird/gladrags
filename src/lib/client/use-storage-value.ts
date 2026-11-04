"use client";

import { useSyncExternalStore } from "react";

/** Fired on window by notifyStorageChange, so readers in this tab see their own writes. */
const CHANGE_EVENT = "gladrags-storage-change";

/** Call after writing to storage that a useStorageValue reader shows. */
export function notifyStorageChange(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(CHANGE_EVENT));
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, onChange);
  // Other tabs (localStorage only; sessionStorage is per tab).
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

/**
 * The raw string stored under `key`, read after hydration:
 * - `undefined` on the server and during hydration (not known yet),
 * - `null` if nothing is stored, or storage is blocked,
 * - otherwise the stored string. Parse it yourself (with checks: storage
 *   is outside our control).
 */
export function useStorageValue(area: "local" | "session", key: string | null): string | null | undefined {
  return useSyncExternalStore(
    subscribe,
    () => {
      if (key === null) return null;
      try {
        return (area === "local" ? window.localStorage : window.sessionStorage).getItem(key);
      } catch {
        return null;
      }
    },
    () => undefined,
  );
}
