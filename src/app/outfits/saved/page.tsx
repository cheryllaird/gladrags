import type { Metadata } from "next";
import { SavedOutfitsScreen } from "@/components/outfits/saved-outfits-screen";

export const metadata: Metadata = { title: "Saved outfits" };

export default function SavedOutfitsPage() {
  return <SavedOutfitsScreen />;
}
