"use client";

import { BookmarkIcon, PlusIcon, ShirtIcon, SparklesIcon, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { NAV_ITEMS, activeNavHref, showsAppChrome, type NavItem } from "./nav-items";

const ICONS: Record<NavItem["icon"], LucideIcon> = {
  wardrobe: ShirtIcon,
  add: PlusIcon,
  outfits: SparklesIcon,
  saved: BookmarkIcon,
};

/**
 * The signed-in app frame: page content in a phone-width column, with a
 * bottom navigation bar fixed in thumb reach. Signed-out pages (sign-in)
 * get the bare content. Lives in the root layout, so every page, including
 * outfit-ui's, gets the same frame without extra wiring.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? "/";
  if (!showsAppChrome(pathname)) return <>{children}</>;

  return (
    // Pages pad their own bottom with --bottom-nav-height (see globals.css).
    <div className="app-chrome min-h-dvh">
      {children}
      <BottomNav pathname={pathname} />
    </div>
  );
}

function BottomNav({ pathname }: { pathname: string }) {
  const active = activeNavHref(pathname);
  return (
    <nav
      aria-label="Main"
      className="bg-background/95 supports-[backdrop-filter]:bg-background/85 fixed inset-x-0 bottom-0 z-40 border-t pb-[env(safe-area-inset-bottom)] backdrop-blur"
    >
      <ul className="mx-auto grid h-[var(--bottom-nav-height)] max-w-md grid-cols-4">
        {NAV_ITEMS.map((item) => {
          const Icon = ICONS[item.icon];
          const isActive = active === item.href;
          return (
            <li key={item.href} className="flex">
              <Link
                href={item.href}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "flex flex-1 flex-col items-center justify-center gap-1 text-xs font-medium outline-none",
                  "focus-visible:ring-ring/50 focus-visible:ring-[3px] focus-visible:ring-inset",
                  isActive ? "text-foreground" : "text-muted-foreground",
                )}
              >
                <Icon className={cn("size-6", isActive && "stroke-[2.25]")} aria-hidden="true" />
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
