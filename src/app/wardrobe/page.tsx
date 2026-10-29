import type { Metadata } from "next";
import { SignedInUser } from "@/components/app-shell/signed-in-user";
import { filtersFromParams } from "@/components/wardrobe/wardrobe-filter-values";
import { getSessionUserOrNull } from "@/lib/auth/session";
import { WardrobeScreen } from "./wardrobe-screen";

export const metadata: Metadata = { title: "Wardrobe" };

export default async function WardrobePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const initialFilters = filtersFromParams(await searchParams);
  // For the Account sheet, and to forget another user's data in this tab.
  // If it can't be read, the sheet just leaves the email out.
  const user = await getSessionUserOrNull();
  return (
    <>
      <SignedInUser userId={user?.id ?? null} />
      <WardrobeScreen initialFilters={initialFilters} email={user?.email ?? null} />
    </>
  );
}
