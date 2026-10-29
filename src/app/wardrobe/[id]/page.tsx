import type { Metadata } from "next";
import { SignedInUser } from "@/components/app-shell/signed-in-user";
import { getSessionUserOrNull } from "@/lib/auth/session";
import { ItemDetailScreen } from "./item-detail-screen";

export const metadata: Metadata = { title: "Item" };

export default async function ItemPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // So deleting returns to this user's wardrobe search, never one left in
  // the tab by someone else (see SignedInUser).
  const user = await getSessionUserOrNull();
  return (
    <>
      <SignedInUser userId={user?.id ?? null} />
      <ItemDetailScreen id={id} />
    </>
  );
}
