/**
 * The one cut-out queue the collages share, wired to the browser: the
 * shared in-browser background remover (loaded once, on first use), the
 * upload limits, and PUT /api/items/[id]/cutout. See cutout-queue.ts.
 *
 * Client-only. Lives for the page session, so moving between the results
 * and the saved outfits doesn't cut the same item out twice.
 */
import { getClientBackgroundRemover } from "@/lib/client/background-remover";
import { fitCutout } from "@/lib/client/photo";
import { outfitsApi } from "./api";
import { CutoutQueue } from "./cutout-queue";

async function fetchOriginal(url: string): Promise<Blob> {
  const response = await fetch(url, { credentials: "same-origin" });
  if (!response.ok) throw new Error(`Original image request failed: ${response.status}`);
  return response.blob();
}

export const collageCutouts = new CutoutQueue(() => {
  const remover = getClientBackgroundRemover();
  return {
    fetchOriginal,
    removeBackground: (image) => remover.removeBackground(image),
    fitCutout,
    upload: async (itemId, cutout) => (await outfitsApi.uploadCutout(itemId, cutout)).ok,
    toUrl: (cutout) => URL.createObjectURL(cutout),
    revokeUrl: (url) => URL.revokeObjectURL(url),
  };
});

/**
 * Whether collages cut items out here. Always for people. Browsers driven
 * by automation (navigator.webdriver, i.e. the e2e tests) skip it unless the
 * test opts in with `window.__GLADRAGS_TEST_COLLAGE_CUTOUTS__ = true` (see
 * tests/e2e/outfits-gaps.spec.ts, which also uses the fake remover): otherwise every
 * test that shows a collage would download the model, and its uploads would
 * change the shared mock wardrobe under other tests (the camel coat would
 * gain a cut-out). The real model has its own browser tests.
 */
export function collageCutoutsEnabled(): boolean {
  if (typeof navigator === "undefined") return false;
  const optedIn = (globalThis as { __GLADRAGS_TEST_COLLAGE_CUTOUTS__?: boolean }).__GLADRAGS_TEST_COLLAGE_CUTOUTS__ === true;
  return optedIn || !navigator.webdriver;
}
