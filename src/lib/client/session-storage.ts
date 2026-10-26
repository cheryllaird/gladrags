/**
 * Everything GladRags keeps in sessionStorage uses this key prefix (the
 * kept add-item draft, the wardrobe filters to return to), so it can all be
 * cleared in one go when the user signs out or deletes their account. That
 * way nothing from one person's session is left in the tab for the next.
 */
export const SESSION_STORAGE_PREFIX = "gladrags:";

/** Remove every `gladrags:*` sessionStorage key. Never throws. */
export function clearGladragsSessionStorage(): void {
  try {
    const storage = window.sessionStorage;
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key?.startsWith(SESSION_STORAGE_PREFIX)) keys.push(key);
    }
    for (const key of keys) storage.removeItem(key);
  } catch {
    // Storage blocked (private browsing): nothing was kept, so there's nothing to clear.
  }
}
