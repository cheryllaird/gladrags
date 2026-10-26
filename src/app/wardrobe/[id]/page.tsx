import type { Metadata } from "next";
import { ItemDetailScreen } from "./item-detail-screen";

export const metadata: Metadata = { title: "Item" };

export default async function ItemPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ItemDetailScreen id={id} />;
}
