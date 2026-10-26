import type { Metadata } from "next";
import { filtersFromParams } from "@/components/wardrobe/wardrobe-filter-values";
import { getSessionUser } from "@/lib/auth/session";
import { WardrobeScreen } from "./wardrobe-screen";

export const metadata: Metadata = { title: "Wardrobe" };

export default async function WardrobePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const initialFilters = filtersFromParams(await searchParams);
  // For the Account sheet. If it can't be read, the sheet just leaves it out.
  const user = await getSessionUser().catch(() => null);
  return <WardrobeScreen initialFilters={initialFilters} email={user?.email ?? null} />;
}
