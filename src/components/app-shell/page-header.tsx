import { ChevronLeftIcon } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * A page's title row, with an optional back link and actions on the right.
 * Sticks to the top so the title stays in view while scrolling.
 */
export function PageHeader({
  title,
  backHref,
  backLabel = "Back",
  actions,
}: {
  title: string;
  backHref?: string;
  backLabel?: string;
  actions?: React.ReactNode;
}) {
  return (
    <header className="bg-background/95 supports-[backdrop-filter]:bg-background/85 sticky top-0 z-30 border-b pt-[env(safe-area-inset-top)] backdrop-blur">
      <div className="mx-auto flex h-14 max-w-md items-center gap-1 px-2">
        {backHref ? (
          <Button asChild variant="ghost" size="icon" aria-label={backLabel}>
            <Link href={backHref}>
              <ChevronLeftIcon className="size-6" aria-hidden="true" />
            </Link>
          </Button>
        ) : (
          <span className="w-2" aria-hidden="true" />
        )}
        <h1 className="min-w-0 flex-1 truncate text-lg font-semibold tracking-tight">{title}</h1>
        {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
      </div>
    </header>
  );
}

/**
 * The standard content column under a PageHeader, with room at the bottom
 * for the bottom navigation (the same spacing outfit-ui's pages use).
 */
export function PageBody({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <main
      className={cn(
        "mx-auto w-full max-w-md px-4 pt-4 pb-[calc(var(--bottom-nav-height,0px)+env(safe-area-inset-bottom,0px)+1.5rem)]",
        className,
      )}
    >
      {children}
    </main>
  );
}
