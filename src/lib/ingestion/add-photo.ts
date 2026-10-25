/**
 * POST /api/items/photo, the real version (spec: "Add by photo", steps 3–4;
 * CONTRACTS.md section 5).
 *
 * The phone has already resized the photo and tried to cut the item out.
 * Here the server checks the caps, checks both images, strips EXIF, stores
 * them in the private buckets, tags the cut-out (or the original) and
 * returns a draft for the user to review. Nothing is saved to the items
 * table until the user confirms (POST /api/items).
 */
import "server-only";
import { STORAGE_BUCKETS, UPLOAD_FIELDS, type ItemDraft } from "@/contracts";
import type { ImageInput, TaggingProvider } from "@/lib/ai/types";
import type { PhotoUpload } from "@/lib/api/upload";
import { SIGNED_URL_TTL_SECONDS, type ServerImageProcessor } from "@/lib/images/server";
import type { UsageGuard } from "@/lib/usage/guard";
import { CUTOUT_RULES, ORIGINAL_RULES, checkUploadedCutout, checkUploadedImage, cleanImage } from "./images";
import { newImageKey, type ImageStorage } from "./storage";
import { suggestTags } from "./tagging";

export interface PhotoIngestionDeps {
  images: ServerImageProcessor;
  storage: ImageStorage;
  tagger: TaggingProvider;
  usage: UsageGuard;
}

export async function addItemFromPhoto(deps: PhotoIngestionDeps, userId: string, upload: PhotoUpload): Promise<ItemDraft> {
  // 1. Caps first (AI paused, or today's items used up), before any work.
  await deps.usage.assertCanStart(userId, "item_ingest");

  // 2–3. Real type, size and pixel dimensions; the cut-out must be transparent.
  const original = await checkUploadedImage(deps.images, upload.original, UPLOAD_FIELDS.original, "photo", ORIGINAL_RULES);
  const cutout = upload.cutout ? await checkUploadedCutout(deps.images, upload.cutout, UPLOAD_FIELDS.cutout) : null;

  // The upload is valid: count it now, because tagging (which costs) happens in this request.
  await deps.usage.recordAction(userId, "item_ingest");

  // 4. Strip EXIF (location included) from both.
  const cleanOriginal = await cleanImage(deps.images, original, ORIGINAL_RULES.maxBytes);
  const cleanCutout = cutout ? await cleanImage(deps.images, cutout, CUTOUT_RULES.maxBytes) : null;

  // 5. Store both in the private buckets.
  const stored = await storeImages(deps.storage, userId, cleanOriginal, cleanCutout);
  try {
    // 6. Tag the cut-out if there is one, otherwise the original.
    const suggestedTags = await suggestTags(deps, userId, cleanCutout ?? cleanOriginal);

    // 7. The draft, with signed URLs so the phone can show the images.
    const [originalUrls, cutoutUrls] = await Promise.all([
      deps.storage.signedUrls(STORAGE_BUCKETS.originals, [stored.originalKey], SIGNED_URL_TTL_SECONDS),
      stored.cutoutKey
        ? deps.storage.signedUrls(STORAGE_BUCKETS.cutouts, [stored.cutoutKey], SIGNED_URL_TTL_SECONDS)
        : Promise.resolve(new Map<string, string>()),
    ]);
    const originalUrl = originalUrls.get(stored.originalKey);
    const cutoutUrl = stored.cutoutKey ? cutoutUrls.get(stored.cutoutKey) : null;
    if (!originalUrl || cutoutUrl === undefined) throw new Error("Couldn't sign the new images' URLs");

    return {
      source: upload.sourceUrl ? "link" : "photo",
      sourceUrl: upload.sourceUrl ?? null,
      originalImageKey: stored.originalKey,
      cutoutImageKey: stored.cutoutKey,
      originalUrl,
      cutoutUrl,
      suggestedTags,
    };
  } catch (error) {
    await removeQuietly(deps.storage, stored);
    throw error;
  }
}

interface StoredKeys {
  originalKey: string;
  cutoutKey: string | null;
}

async function storeImages(
  storage: ImageStorage,
  userId: string,
  original: ImageInput,
  cutout: ImageInput | null,
): Promise<StoredKeys> {
  const originalKey = newImageKey(userId, original.mimeType);
  await storage.upload(STORAGE_BUCKETS.originals, originalKey, original);
  if (!cutout) return { originalKey, cutoutKey: null };

  const cutoutKey = newImageKey(userId, cutout.mimeType);
  try {
    await storage.upload(STORAGE_BUCKETS.cutouts, cutoutKey, cutout);
  } catch (error) {
    await removeQuietly(storage, { originalKey, cutoutKey: null });
    throw error;
  }
  return { originalKey, cutoutKey };
}

/** Best effort: anything left behind is caught by the orphaned-image cleanup. */
async function removeQuietly(storage: ImageStorage, keys: StoredKeys): Promise<void> {
  try {
    await storage.remove(STORAGE_BUCKETS.originals, [keys.originalKey]);
    if (keys.cutoutKey) await storage.remove(STORAGE_BUCKETS.cutouts, [keys.cutoutKey]);
  } catch (error) {
    console.error("Couldn't remove images after a failed upload", error instanceof Error ? error.message : "unknown");
  }
}
