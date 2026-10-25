import type { Metadata } from "next";
import { IdSchema } from "@/contracts";
import { OutfitsScreen } from "@/components/outfits/outfits-screen";

export const metadata: Metadata = { title: "Outfits" };

interface Props {
  searchParams: Promise<{ anchor?: string | string[] }>;
}

/**
 * /outfits, and /outfits?anchor=<itemId> from item detail's
 * "Build an outfit around this". An invalid anchor is ignored.
 */
export default async function OutfitsPage({ searchParams }: Props) {
  const { anchor } = await searchParams;
  const parsed = IdSchema.safeParse(Array.isArray(anchor) ? anchor[0] : anchor);
  const anchorId = parsed.success ? parsed.data : null;
  // Keyed so arriving with a different anchor starts a fresh request.
  return <OutfitsScreen key={anchorId ?? "none"} initialAnchorId={anchorId} />;
}
