/**
 * Changing an existing item's pictures (CONTRACTS.md section 5, milestone 5):
 *
 * - PUT /api/items/[id]/cutout: the cut-out the phone made the first time
 *   a collage needed the item (spec: "Collage preview").
 * - PUT /api/items/[id]/photo: a real photo for an item that has none yet
 *   (an order-email line without a usable picture, needsPhoto).
 *
 * Neither uses AI, so neither checks or counts a cap. Both run the same
 * checks as add-by-photo (real type, size, pixel limits, a full decode,
 * EXIF stripped) before storing anything, and delete the file they
 * replaced once the item points at the new one.
 */
import "server-only";
import { STORAGE_BUCKETS, UPLOAD_FIELDS, type WardrobeItem } from "@/contracts";
import { notFound } from "@/lib/api/errors";
import type { UploadedImage } from "@/lib/api/upload";
import type { ServerImageProcessor } from "@/lib/images/server";
import { CUTOUT_RULES, ORIGINAL_RULES, checkUploadedCutout, checkUploadedImage, cleanImage, invalidImage } from "./images";
import { DuplicateImageKeyError } from "./items-repository";
import { newImageKey, type ImageBucket } from "./storage";
import { toWardrobeItem, type WardrobeDeps } from "./wardrobe";

export interface ItemImageDeps extends WardrobeDeps {
  images: ServerImageProcessor;
}

/**
 * Store a new cut-out for the user's item and return the item.
 *
 * The cut-out must be a PNG with a see-through background (at least 1% of
 * pixels with alpha below 250) and no wider or taller than the item's
 * stored original. A PNG that isn't see-through is refused here: unlike
 * the old add-time cut-out there's nothing to fall back to, and saving it
 * would put a rectangle in every collage.
 *
 * A newer cut-out replaces an older one, and the older file is deleted.
 * If two phones race, each deletes the file it replaced; a cut-out that
 * lost the race is left unreferenced and the orphaned-image cleanup
 * removes it.
 */
export async function setItemCutout(deps: ItemImageDeps, userId: string, itemId: string, upload: UploadedImage): Promise<WardrobeItem> {
  const field = UPLOAD_FIELDS.cutout;
  const row = await deps.items.get(userId, itemId);
  if (!row) throw notFound("That item");

  // The stored original is EXIF-stripped, so its size is already upright.
  const storedOriginal = await deps.storage.download(STORAGE_BUCKETS.originals, row.original_image_key);
  const originalInfo = await deps.images.inspect(storedOriginal.data);

  const cutout = await checkUploadedCutout(deps.images, upload, field, originalInfo);
  if (!cutout) throw invalidImage(field, "cut-out", "Must have a see-through background");
  const clean = await cleanImage(deps.images, cutout, CUTOUT_RULES.maxBytes, field, "cut-out");

  const newKey = newImageKey(userId, clean.mimeType);
  await deps.storage.upload(STORAGE_BUCKETS.cutouts, newKey, clean);
  const updated = await pointItemAt(deps, STORAGE_BUCKETS.cutouts, newKey, () => deps.items.setCutoutKey(userId, itemId, newKey));

  if (row.cutout_image_key && row.cutout_image_key !== newKey) {
    await removeReplaced(deps, STORAGE_BUCKETS.cutouts, row.cutout_image_key, itemId);
  }
  return toWardrobeItem(deps.storage, updated);
}

/**
 * Give the user's item a new original photo and return the item.
 *
 * Checked like add-by-photo. The item's old original (the placeholder for
 * an email item) and any cut-out, which was cut from the old picture, are
 * deleted. needs_photo is cleared and the item goes back to "to review",
 * so the user can check its tags against the photo. The tags are kept:
 * no re-tagging (CONTRACTS.md section 11, decision 5).
 */
export async function replaceItemPhoto(deps: ItemImageDeps, userId: string, itemId: string, upload: UploadedImage): Promise<WardrobeItem> {
  const field = UPLOAD_FIELDS.original;
  const row = await deps.items.get(userId, itemId);
  if (!row) throw notFound("That item");

  const photo = await checkUploadedImage(deps.images, upload, field, "photo", ORIGINAL_RULES);
  const clean = await cleanImage(deps.images, photo, ORIGINAL_RULES.maxBytes, field, "photo");

  const newKey = newImageKey(userId, clean.mimeType);
  await deps.storage.upload(STORAGE_BUCKETS.originals, newKey, clean);
  const updated = await pointItemAt(deps, STORAGE_BUCKETS.originals, newKey, () => deps.items.replaceOriginal(userId, itemId, newKey));

  // The row read at the start names the files this request replaced.
  if (row.original_image_key !== newKey) await removeReplaced(deps, STORAGE_BUCKETS.originals, row.original_image_key, itemId);
  if (row.cutout_image_key) await removeReplaced(deps, STORAGE_BUCKETS.cutouts, row.cutout_image_key, itemId);
  return toWardrobeItem(deps.storage, updated);
}

/**
 * Run the row update for a freshly stored image. If the item has gone (deleted
 * meanwhile) or the update fails, remove the new file and fail.
 */
async function pointItemAt<T>(deps: WardrobeDeps, bucket: ImageBucket, newKey: string, update: () => Promise<T | null>): Promise<T> {
  let updated: T | null;
  try {
    updated = await update();
  } catch (error) {
    await deps.storage.remove(bucket, [newKey]).catch(() => {});
    if (error instanceof DuplicateImageKeyError) throw new Error("A new image key was already in use");
    throw error;
  }
  if (!updated) {
    await deps.storage.remove(bucket, [newKey]).catch(() => {});
    throw notFound("That item");
  }
  return updated;
}

/** Best effort: the item already points at the new file, and the orphaned-image cleanup catches anything left. */
async function removeReplaced(deps: WardrobeDeps, bucket: ImageBucket, key: string, itemId: string): Promise<void> {
  try {
    await deps.storage.remove(bucket, [key]);
  } catch (error) {
    console.error("Couldn't delete a replaced image", { itemId, bucket, error: error instanceof Error ? error.message : "unknown" });
  }
}
