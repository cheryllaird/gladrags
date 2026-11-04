import { cn } from "@/lib/utils";

/**
 * An item's picture: always the original photo or product image (spec:
 * "The wardrobe shows the original image"). Cut-outs are only for
 * collages. Shared by the wardrobe grid, item detail, the review list and
 * the tag review screen.
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
  onError,
}: {
  item: { originalUrl: string };
  alt: string;
  className?: string;
  fit?: "contain" | "cover";
  priority?: boolean;
  /** The image failed to load: its signed URL may have expired (see useSignedUrlRefresh). */
  onError?: () => void;
}) {
  return (
    <div className={cn("bg-muted relative aspect-square overflow-hidden rounded-lg", className)}>
      {/* eslint-disable-next-line @next/next/no-img-element -- signed URLs; see comment above */}
      <img
        src={item.originalUrl}
        alt={alt}
        loading={priority ? "eager" : "lazy"}
        decoding="async"
        onError={onError}
        className={cn("size-full", fit === "contain" ? "object-contain p-2" : "object-cover")}
      />
    </div>
  );
}
