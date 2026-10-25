"use client";

import { useEffect, useRef } from "react";
import { takePendingAdd, type PendingAdd } from "./pending-add";

/**
 * After signing in again, hand the add screen whatever it kept when the
 * session expired (see pending-add.ts). Runs once, after hydration, because
 * sessionStorage only exists in the browser.
 */
export function useRestorePendingAdd(restore: (pending: PendingAdd) => void): void {
  const latest = useRef(restore);
  useEffect(() => {
    latest.current = restore;
  });
  useEffect(() => {
    const pending = takePendingAdd();
    if (pending) latest.current(pending);
  }, []);
}
