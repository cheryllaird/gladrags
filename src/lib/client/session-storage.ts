/**
 * Everything GladRags keeps in sessionStorage uses this key prefix (the
 * kept add-item draft, the wardrobe filters to return to, whose tab it
 * is), so it can all be cleared in one go when the user signs out, deletes
 * their account, or someone else signs in on the same tab. That way
 * nothing from one person's session is left in the tab for the next.
 */
export const SESSION_STORAGE_PREFIX = "gladrags:";

/** The ID of the user the tab's GladRags data belongs to (see forgetOtherUsersData). */
export const SESSION_USER_KEY = `${SESSION_STORAGE_PREFIX}user`;

/**
 * Remove every `gladrags:*` sessionStorage key, except any that `keep`
 * says to leave. Never throws.
 */
export function clearGladragsSessionStorage(keep: (key: string) => boolean = () => false): void {
  try {
    const storage = window.sessionStorage;
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key?.startsWith(SESSION_STORAGE_PREFIX) && !keep(key)) keys.push(key);
    }
    for (const key of keys) storage.removeItem(key);
  } catch {
    // Storage blocked (private browsing): nothing was kept, so there's nothing to clear.
  }
}
