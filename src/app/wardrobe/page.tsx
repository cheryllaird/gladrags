import type { Metadata } from "next";
import { filtersFromParams } from "@/components/wardrobe/wardrobe-filter-values";
import { WardrobeScreen } from "./wardrobe-screen";

export const metadata: Metadata = { title: "Wardrobe" };

export default async function WardrobePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const initialFilters = filtersFromParams(await searchParams);
  return <WardrobeScreen initialFilters={initialFilters} />;
}
