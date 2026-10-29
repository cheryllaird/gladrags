import type { Metadata } from "next";
import { SignedInUser } from "@/components/app-shell/signed-in-user";
import { getSessionUserOrNull } from "@/lib/auth/session";
import { AddPhotoFlow } from "./add-photo-flow";

export const metadata: Metadata = { title: "Add an item" };

export default async function AddPage() {
  // Whose add this is, so a draft kept when a session expired is only
  // restored for the same user (pending-add.ts). If it can't be read,
  // nothing is kept or restored.
  const user = await getSessionUserOrNull();
  const userId = user?.id ?? null;
  return (
    <>
      <SignedInUser userId={userId} />
      <AddPhotoFlow userId={userId} />
    </>
  );
}
