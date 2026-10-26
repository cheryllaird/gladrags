/**
 * The wardrobe item routes, the real versions (CONTRACTS.md section 5,
 * "Wardrobe items"): list with filters and search, read one, save a
 * reviewed draft, replace tags, delete with images.
 */
import "server-only";
import {
  STORAGE_BUCKETS,
  imageKeyBelongsTo,
  type CreateItemRequest,
  type ItemListQuery,
  type ItemRow,
  type ItemTags,
  type WardrobeItem,
} from "@/contracts";
import { ApiException, notFound } from "@/lib/api/errors";
import { itemRowToWardrobeItem } from "@/lib/db/mappers";
import { SIGNED_URL_TTL_SECONDS } from "@/lib/images/server";
import { DuplicateImageKeyError, type ItemRepository } from "./items-repository";
import type { ImageStorage } from "./storage";

export interface WardrobeDeps {
  items: ItemRepository;
  storage: ImageStorage;
}

/** Turn rows into API items, signing every image URL in two batched calls. */
export async function toWardrobeItems(storage: ImageStorage, rows: readonly ItemRow[]): Promise<WardrobeItem[]> {
  const cutoutKeys = rows.flatMap((row) => (row.cutout_image_key ? [row.cutout_image_key] : []));
  const [originalUrls, cutoutUrls] = await Promise.all([
    storage.signedUrls(STORAGE_BUCKETS.originals, rows.map((row) => row.original_image_key), SIGNED_URL_TTL_SECONDS),
    storage.signedUrls(STORAGE_BUCKETS.cutouts, cutoutKeys, SIGNED_URL_TTL_SECONDS),
  ]);
  const items: WardrobeItem[] = [];
  for (const row of rows) {
    const originalUrl = originalUrls.get(row.original_image_key);
    if (!originalUrl) {
      // The image is missing from storage. Leave the item out rather than break the whole list.
      console.error("Item has no original image in storage", { itemId: row.id });
      continue;
    }
    // A missing cut-out falls back to the original, as when removal failed on the phone.
    const cutoutUrl = row.cutout_image_key ? (cutoutUrls.get(row.cutout_image_key) ?? null) : null;
    items.push(itemRowToWardrobeItem(row, { originalUrl, cutoutUrl }));
  }
  return items;
}

async function toWardrobeItem(storage: ImageStorage, row: ItemRow): Promise<WardrobeItem> {
  const [item] = await toWardrobeItems(storage, [row]);
  if (!item) throw new Error("Couldn't sign the item's image URL");
  return item;
}

export async function listWardrobe(deps: WardrobeDeps, userId: string, query: ItemListQuery): Promise<WardrobeItem[]> {
  return toWardrobeItems(deps.storage, await deps.items.list(userId, query));
}

export async function getWardrobeItem(deps: WardrobeDeps, userId: string, id: string): Promise<WardrobeItem> {
  const row = await deps.items.get(userId, id);
  if (!row) throw notFound("That item");
  return toWardrobeItem(deps.storage, row);
}

/**
 * Save a reviewed draft. The images must be the user's own, must have been
 * stored by an upload route (so they were checked and EXIF-stripped), and
 * mustn't already belong to another item: deleting one item deletes its
 * images, which would break the other.
 */
export async function createWardrobeItem(deps: WardrobeDeps, userId: string, request: CreateItemRequest): Promise<WardrobeItem> {
  const images = [
    { bucket: STORAGE_BUCKETS.originals, key: request.originalImageKey },
    ...(request.cutoutImageKey ? [{ bucket: STORAGE_BUCKETS.cutouts, key: request.cutoutImageKey }] : []),
  ];
  if (!images.every(({ key }) => imageKeyBelongsTo(key, userId))) {
    throw new ApiException("bad_request", "Those images don't belong to you");
  }
  const present = await Promise.all(images.map(({ bucket, key }) => deps.storage.exists(bucket, key)));
  if (present.includes(false)) {
    throw new ApiException("bad_request", "Those images have expired. Please add the item again.");
  }
  const inUse = await deps.items.keysInUse(userId, images.map(({ key }) => key));
  if (inUse.size > 0) {
    throw new ApiException("bad_request", "That item has already been saved");
  }
  let row;
  try {
    row = await deps.items.create(userId, request);
  } catch (error) {
    // Two saves of this draft at once: the other one won.
    if (error instanceof DuplicateImageKeyError) throw new ApiException("bad_request", "That item has already been saved");
    throw error;
  }
  return toWardrobeItem(deps.storage, row);
}

export async function updateWardrobeItemTags(deps: WardrobeDeps, userId: string, id: string, tags: ItemTags): Promise<WardrobeItem> {
  const row = await deps.items.updateTags(userId, id, tags);
  if (!row) throw notFound("That item");
  return toWardrobeItem(deps.storage, row);
}

/**
 * Delete the item and its images. The database trigger deletes the outfits
 * that used it. If removing the images fails, the item is still gone and
 * the orphaned-image cleanup removes them later.
 */
export async function deleteWardrobeItem(deps: WardrobeDeps, userId: string, id: string): Promise<void> {
  const row = await deps.items.delete(userId, id);
  if (!row) throw notFound("That item");
  try {
    await deps.storage.remove(STORAGE_BUCKETS.originals, [row.original_image_key]);
    if (row.cutout_image_key) await deps.storage.remove(STORAGE_BUCKETS.cutouts, [row.cutout_image_key]);
  } catch (error) {
    console.error("Item deleted but its images weren't", { itemId: id, error: error instanceof Error ? error.message : "unknown" });
  }
}
