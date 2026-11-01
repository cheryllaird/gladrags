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
  };
});
