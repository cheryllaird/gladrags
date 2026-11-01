/**
 * Small pictures of items for ranking pass 2 (spec: "around 256 px"). The
 * engine depends only on ThumbnailSource, so tests use a fake and never
 * touch storage.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ImageInput } from "@/lib/ai/types";
import { describeError } from "@/lib/api/http";
import { RANKING_THUMBNAIL_PX, sniffImageType } from "@/lib/images/server";
import { THUMBNAIL_CONCURRENCY } from "./config";
import type { ImageRef, WardrobeEntry } from "./types";

export interface ThumbnailSource {
  /**
   * A ~256 px picture of each item's cut-out (or its original when there's
   * no cut-out), by item ID. An item without a picture (`image` null: it
   * still needs a photo) or whose picture can't be loaded is left out, and
   * ranking goes ahead with its tags only.
   */
  getThumbnails(items: readonly WardrobeEntry[]): Promise<Map<string, ImageInput>>;
}

/** Reads stored image bytes. */
export interface ImageStore {
  download(ref: ImageRef): Promise<ImageInput>;
}

/** Shrinks an image to fit within maxPx on its longest side. */
export type ImageResizer = (image: ImageInput, maxPx: number) => Promise<ImageInput>;

/** Run `task` over `values`, at most `limit` at a time. */
export async function mapWithLimit<T, R>(values: readonly T[], limit: number, task: (value: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(values.length);
  let next = 0;
  const worker = async () => {
    while (next < values.length) {
      const index = next++;
      results[index] = await task(values[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return results;
}

/** Downloads each item's picture and shrinks it. */
export class ResizingThumbnailSource implements ThumbnailSource {
  constructor(
    private readonly store: ImageStore,
    private readonly resize: ImageResizer,
    private readonly maxPx = RANKING_THUMBNAIL_PX,
  ) {}

  async getThumbnails(items: readonly WardrobeEntry[]): Promise<Map<string, ImageInput>> {
    const pictured = items.filter((item): item is WardrobeEntry & { image: ImageRef } => item.image !== null);
    const results = await mapWithLimit(pictured, THUMBNAIL_CONCURRENCY, async (item) => {
      try {
        const image = await this.store.download(item.image);
        return [item.id, await this.resize(image, this.maxPx)] as const;
      } catch (error) {
        // Never send the full-size image instead: that would make the
        // request's cost unbounded. Ranking uses the item's tags.
        console.error("Couldn't make a ranking thumbnail", describeError(error));
        return null;
      }
    });
    return new Map(results.filter((r) => r !== null));
  }
}

/** Reads images from the private Supabase Storage buckets, as the signed-in user (storage RLS applies). */
export class SupabaseImageStore implements ImageStore {
  constructor(private readonly client: SupabaseClient) {}

  async download(ref: ImageRef): Promise<ImageInput> {
    const { data, error } = await this.client.storage.from(ref.bucket).download(ref.key);
    if (error || !data) throw new Error(`Couldn't download image: ${error?.message ?? "no data"}`);
    const bytes = new Uint8Array(await data.arrayBuffer());
    const mimeType = sniffImageType(bytes);
    if (!mimeType) throw new Error("Stored image isn't JPEG, PNG or WebP");
    return { data: bytes, mimeType };
  }
}

/** A valid 1×1 transparent PNG. */
const PLACEHOLDER_PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0),
);

/** Mock mode and tests: the same placeholder picture for every item. */
export class PlaceholderThumbnailSource implements ThumbnailSource {
  readonly requested: string[][] = [];

  async getThumbnails(items: readonly WardrobeEntry[]): Promise<Map<string, ImageInput>> {
    this.requested.push(items.map((i) => i.id));
    return new Map(
      items.filter((item) => item.image !== null).map((item) => [item.id, { data: PLACEHOLDER_PNG, mimeType: "image/png" as const }]),
    );
  }
}
