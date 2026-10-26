"use client";

import { useEffect, useRef } from "react";
import { takePendingAdd, type PendingAdd } from "./pending-add";

/**
 * After signing in again, hand the add screen whatever it kept when the
 * session expired (see pending-add.ts), if it was kept for this same user.
 * Runs once, after hydration, because sessionStorage only exists in the
 * browser.
 */
export function useRestorePendingAdd(userId: string | null, restore: (pending: PendingAdd) => void): void {
  const latest = useRef(restore);
  useEffect(() => {
    latest.current = restore;
  });
  useEffect(() => {
    const pending = takePendingAdd(userId);
    if (pending) latest.current(pending);
    // Once, for the user the page was rendered for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
