import { cn } from "@/lib/utils";

/**
 * Primary actions pinned just above the bottom navigation, in easy reach of
 * a thumb. Place it last in the page content (inside PageBody).
 */
export function StickyActions({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "bg-background/95 supports-[backdrop-filter]:bg-background/80 sticky bottom-[calc(var(--bottom-nav-height,0px)+env(safe-area-inset-bottom,0px))] z-10 -mx-4 flex gap-2 border-t px-4 py-3 backdrop-blur",
        className,
      )}
    >
      {children}
    </div>
  );
}
