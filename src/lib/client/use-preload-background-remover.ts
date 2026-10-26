"use client";

import { useEffect } from "react";
import { preloadBackgroundRemover } from "@/lib/images";
import { usesTestFakeRemover } from "./background-remover";

/**
 * Start fetching the background-removal model as soon as an add screen
 * opens, so the first photo doesn't wait for the download. Never throws: a
 * failure is retried, then falls back to "no cut-out", when a photo is
 * processed.
 */
export function usePreloadBackgroundRemover(): void {
  useEffect(() => {
    if (!usesTestFakeRemover()) void preloadBackgroundRemover();
  }, []);
}
