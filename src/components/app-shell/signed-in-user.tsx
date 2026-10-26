"use client";

import { useEffect } from "react";
import { PENDING_ADD_KEY, pendingAddOwner } from "@/components/wardrobe/add/pending-add";
import { SESSION_USER_KEY, clearGladragsSessionStorage } from "@/lib/client/session-storage";

/**
 * If the tab's GladRags data belongs to someone other than `userId` (the
 * signed-in user), forget all of it: say A's session expired and B signed
 * in on the same tab, B mustn't get A's wardrobe search or kept draft. The
 * one thing kept is a draft kept for `userId` themselves (their own work,
 * saved when their session expired). Then record `userId` as the owner.
 */
export function forgetOtherUsersData(userId: string): void {
  try {
    const storage = window.sessionStorage;
    if (storage.getItem(SESSION_USER_KEY) === userId) return;
    const ownDraft = pendingAddOwner() === userId;
    clearGladragsSessionStorage((key) => ownDraft && key === PENDING_ADD_KEY);
    storage.setItem(SESSION_USER_KEY, userId);
  } catch {
    // Storage blocked: nothing can have been kept.
  }
}

/**
 * Rendered by pages that know the signed-in user (from the server), before
 * their content, so its effect runs before theirs read anything. Renders
 * nothing. pending-add.ts also checks the owner itself, so this ordering is
 * a second line of defence for the kept draft, not the only one.
 */
export function SignedInUser({ userId }: { userId: string | null }) {
  useEffect(() => {
    if (userId) forgetOtherUsersData(userId);
  }, [userId]);
  return null;
}
