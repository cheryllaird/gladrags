/**
 * Getting items into the wardrobe: add-by-photo, the shared tagging step,
 * the wardrobe item routes' logic, and orphaned-image cleanup. Server only.
 *
 * link-import reuses checkUploadedCutout, cleanImage, newImageKey and
 * suggestTags for its step 2, and suggestTagsFromText and saveItemForReview
 * for order emails.
 */
export { addItemFromPhoto, addPhotoForReview, type PhotoIngestionDeps } from "./add-photo";
export { cleanUpOrphanedImages, ORPHAN_MIN_AGE_MS, type CleanupReport } from "./cleanup";
export { getItemImageDeps, getPhotoIngestionDeps, getWardrobeDeps } from "./deps";
export { replaceItemPhoto, setItemCutout, type ItemImageDeps } from "./item-images";
export { CUTOUT_RULES, ORIGINAL_RULES, checkUploadedCutout, checkUploadedImage, cleanImage, invalidImage, type CheckedImage } from "./images";
export {
  InMemoryItemRepository,
  SupabaseImageReferences,
  SupabaseItemRepository,
  type ImageReferences,
  type ItemRepository,
  type NewItem,
} from "./items-repository";
export { InMemoryImageStorage, SupabaseImageStorage, newImageKey, type ImageBucket, type ImageStorage } from "./storage";
export { suggestTags, suggestTagsFromText, type TaggingDeps, type TextTaggingHints } from "./tagging";
export {
  createWardrobeItem,
  deleteWardrobeItem,
  getWardrobeItem,
  listWardrobe,
  markWardrobeItemsReviewed,
  saveItemForReview,
  saveItemRowForReview,
  toWardrobeItem,
  toWardrobeItems,
  updateWardrobeItem,
  updateWardrobeItemTags,
  type ItemForReview,
  type WardrobeDeps,
} from "./wardrobe";
