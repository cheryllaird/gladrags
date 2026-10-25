import { displayImageUrl } from "@/contracts";
import { cn } from "@/lib/utils";

/**
 * An item's picture: the cut-out, or the original photo when background
 * removal failed (displayImageUrl). Shared by the wardrobe grid, item
 * detail, the tag review screen and (if it likes) outfit-ui.
 *
 * A plain <img>, not next/image: these are short-lived signed URLs from
 * private storage, which the image optimiser shouldn't fetch or cache.
 */
export function ItemImage({
  item,
  alt,
  className,
  fit = "contain",
  priority = false,
}: {
  item: { cutoutUrl: string | null; originalUrl: string };
  alt: string;
  className?: string;
  fit?: "contain" | "cover";
  priority?: boolean;
}) {
  return (
    <div className={cn("bg-muted relative aspect-square overflow-hidden rounded-lg", className)}>
      {/* eslint-disable-next-line @next/next/no-img-element -- signed URLs; see comment above */}
      <img
        src={displayImageUrl(item)}
        alt={alt}
        loading={priority ? "eager" : "lazy"}
        decoding="async"
        className={cn("size-full", fit === "contain" ? "object-contain p-2" : "object-cover")}
      />
    </div>
  );
}
