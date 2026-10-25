/**
 * Getting items into the wardrobe: add-by-photo, the shared tagging step,
 * the wardrobe item routes' logic, and orphaned-image cleanup. Server only.
 *
 * link-import reuses checkUploadedCutout, cleanImage, newImageKey and
 * suggestTags for its step 2.
 */
export { addItemFromPhoto, type PhotoIngestionDeps } from "./add-photo";
export { cleanUpOrphanedImages, ORPHAN_MIN_AGE_MS, type CleanupReport } from "./cleanup";
export { getPhotoIngestionDeps, getWardrobeDeps } from "./deps";
export { CUTOUT_RULES, ORIGINAL_RULES, checkUploadedCutout, checkUploadedImage, cleanImage, invalidImage, type CheckedImage } from "./images";
export {
  InMemoryItemRepository,
  SupabaseImageReferences,
  SupabaseItemRepository,
  type ImageReferences,
  type ItemRepository,
} from "./items-repository";
export { InMemoryImageStorage, SupabaseImageStorage, newImageKey, type ImageBucket, type ImageStorage } from "./storage";
export { suggestTags, type TaggingDeps } from "./tagging";
export {
  createWardrobeItem,
  deleteWardrobeItem,
  getWardrobeItem,
  listWardrobe,
  toWardrobeItems,
  updateWardrobeItemTags,
  type WardrobeDeps,
} from "./wardrobe";
