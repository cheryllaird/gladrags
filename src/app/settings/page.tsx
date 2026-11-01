import type { Metadata } from "next";
import { SignedInUser } from "@/components/app-shell/signed-in-user";
import { getSessionUserOrNull } from "@/lib/auth/session";
import { SettingsScreen } from "./settings-screen";

export const metadata: Metadata = { title: "Settings" };

/** Favourite shops, the order-email forwarding address, and recent email imports. */
export default async function SettingsPage() {
  // The sign-in address, for "forward from …". If it can't be read, the copy says "your sign-in address".
  const user = await getSessionUserOrNull();
  return (
    <>
      <SignedInUser userId={user?.id ?? null} />
      <SettingsScreen email={user?.email ?? null} />
    </>
  );
}
