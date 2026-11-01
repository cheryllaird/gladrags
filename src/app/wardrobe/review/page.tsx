import type { Metadata } from "next";
import { SignedInUser } from "@/components/app-shell/signed-in-user";
import { getSessionUserOrNull } from "@/lib/auth/session";
import { ReviewScreen } from "./review-screen";

export const metadata: Metadata = { title: "Review new items" };

/**
 * The review list (spec: Reviewing new items): items added in a batch,
 * saved with their suggested tags and marked "to review"
 * (GET /api/items?needsReview=true), plus batch drafts whose tagging
 * failed. Opened from the wardrobe's "Review N new items" banner.
 */
export default async function ReviewPage() {
  // Whose batch drafts to show (batch-drafts.ts). If it can't be read, drafts are left out.
  const user = await getSessionUserOrNull();
  return (
    <>
      <SignedInUser userId={user?.id ?? null} />
      <ReviewScreen userId={user?.id ?? null} />
    </>
  );
}
