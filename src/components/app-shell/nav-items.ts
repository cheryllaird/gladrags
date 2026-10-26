/**
 * The bottom navigation's destinations. /outfits and /outfits/saved belong
 * to outfit-ui; the nav only links to them.
 */
export interface NavItem {
  href: string;
  label: string;
  icon: "wardrobe" | "add" | "outfits" | "saved";
}

export const NAV_ITEMS: NavItem[] = [
  { href: "/wardrobe", label: "Wardrobe", icon: "wardrobe" },
  { href: "/add", label: "Add", icon: "add" },
  { href: "/outfits", label: "Outfits", icon: "outfits" },
  { href: "/outfits/saved", label: "Saved", icon: "saved" },
];

/** Pages shown without the app chrome (signed-out screens, and the public privacy note). */
const CHROMELESS_PREFIXES = ["/sign-in", "/auth", "/privacy"];

export function showsAppChrome(pathname: string): boolean {
  return !CHROMELESS_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function within(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * The nav item for the current page: the most specific match, so
 * /outfits/saved lights up Saved rather than Outfits. "/" counts as Wardrobe.
 */
export function activeNavHref(pathname: string): string | null {
  if (pathname === "/") return "/wardrobe";
  const matches = NAV_ITEMS.filter((item) => within(pathname, item.href));
  matches.sort((a, b) => b.href.length - a.href.length);
  return matches[0]?.href ?? null;
}
