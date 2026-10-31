/**
 * POST /api/items/link/cutout, step 2 of 2, the real version
 * (CONTRACTS.md section 5).
 *
 * The phone has loaded the step-1 product image and tried to cut it out.
 * Order matters here:
 * 1. Caps first (AI paused, or today's items used up).
 * 2. Look the import up WITHOUT using it, and check and clean the cut-out
 *    against the stored original. A bad cut-out is a 400 and the import
 *    can still be used (follow-up from the foundations review).
 * 3. Count the item (atomically, so a parallel request can't take the
 *    last place today after this one passed), store the cut-out, then
 *    claim the import in one statement. Losing a race (or a replay) is a
 *    404: the stored cut-out is removed and the count taken back.
 * 4. Tag the cut-out (or the original) with the product data the SERVER
 *    stored in step 1 as untrusted hints, return the draft.
 */
import "server-only";
import { STORAGE_BUCKETS, UPLOAD_FIELDS, imageKeyBelongsTo, type BatchAddResponse, type ItemDraft } from "@/contracts";
import type { ImageInput } from "@/lib/ai/types";
import { ApiException } from "@/lib/api/errors";
import type { LinkCutoutUpload } from "@/lib/api/upload";
import { SIGNED_URL_TTL_SECONDS } from "@/lib/images/server";
import { CUTOUT_RULES, checkUploadedCutout, cleanImage } from "@/lib/ingestion/images";
import { DuplicateImageKeyError } from "@/lib/ingestion/items-repository";
import { newImageKey, type ImageStorage } from "@/lib/ingestion/storage";
import { suggestTags, type TaggingDeps } from "@/lib/ingestion/tagging";
import { toWardrobeItems } from "@/lib/ingestion/wardrobe";
import type { ImageStore } from "@/lib/outfits/thumbnails";
import { isAiPausedError } from "@/lib/usage/errors";
import type { LinkImportRepository, OpenLinkImport } from "./repository";
import type { ReviewItemStore } from "./review-items";

export interface LinkCutoutDeps extends TaggingDeps {
  storage: ImageStorage;
  /** Reads the stored step-1 image back (admin client). */
  imageStore: ImageStore;
  linkImports: LinkImportRepository;
  /** Saves batch-added items as "to review" (the signed-in user's client). */
  reviewItems: ReviewItemStore;
}

function importGone(): ApiException {
  return new ApiException("not_found", "That link has expired or was already added. Paste the link again to start over.");
}

export async function finishLinkImport(deps: LinkCutoutDeps, userId: string, upload: LinkCutoutUpload): Promise<ItemDraft> {
  // 1. Caps.
  await deps.usage.assertCanStart(userId, "item_ingest");

  // 2. The import must be this user's, unused and in time. Read only.
  const originalKey = upload.meta.originalImageKey;
  if (!imageKeyBelongsTo(originalKey, userId)) throw importGone();
  if (!(await deps.linkImports.findOpen(userId, originalKey))) throw importGone();
  if (!(await deps.storage.exists(STORAGE_BUCKETS.originals, originalKey))) throw importGone();

  const original = await deps.imageStore.download({ bucket: STORAGE_BUCKETS.originals, key: originalKey });
  const originalInfo = await deps.images.inspect(original.data);

  // Check and clean the cut-out before the import is used up.
  const checked = upload.cutout ? await checkUploadedCutout(deps.images, upload.cutout, UPLOAD_FIELDS.cutout, originalInfo) : null;
  const cutout = checked ? await cleanImage(deps.images, checked, CUTOUT_RULES.maxBytes, UPLOAD_FIELDS.cutout, "cut-out") : null;

  // 3. Count it (tagging, which costs, happens in this request). Before
  // the claim, so a cap reached meanwhile doesn't use the import up.
  const counted = await deps.usage.reserveAction(userId, "item_ingest");

  // Store the cut-out, then claim.
  const cutoutKey = cutout ? newImageKey(userId, cutout.mimeType) : null;
  try {
    if (cutout && cutoutKey) await deps.storage.upload(STORAGE_BUCKETS.cutouts, cutoutKey, cutout);
  } catch (error) {
    await counted.cancel().catch(() => {});
    throw error;
  }
  const removeCutout = async () => {
    if (cutoutKey) await deps.storage.remove(STORAGE_BUCKETS.cutouts, [cutoutKey]).catch(() => {});
  };

  let claimed: OpenLinkImport | null;
  try {
    claimed = await deps.linkImports.claim(userId, originalKey);
  } catch (error) {
    await removeCutout();
    await counted.cancel().catch(() => {});
    throw error;
  }
  if (!claimed) {
    await removeCutout();
    // Best effort: a failed refund mustn't turn the 404 into a 500.
    await counted.cancel().catch(() => {});
    throw importGone();
  }

  try {
    // 4. Tag it.
    const tagImage: ImageInput = cutout ?? original;
    const suggestedTags = await suggestTags(deps, userId, tagImage, claimed.product);

    const [originalUrls, cutoutUrls] = await Promise.all([
      deps.storage.signedUrls(STORAGE_BUCKETS.originals, [originalKey], SIGNED_URL_TTL_SECONDS),
      cutoutKey ? deps.storage.signedUrls(STORAGE_BUCKETS.cutouts, [cutoutKey], SIGNED_URL_TTL_SECONDS) : Promise.resolve(new Map<string, string>()),
    ]);
    const originalUrl = originalUrls.get(originalKey);
    const cutoutUrl = cutoutKey ? cutoutUrls.get(cutoutKey) : null;
    if (!originalUrl || cutoutUrl === undefined) throw new Error("Couldn't sign the new images' URLs");

    return {
      source: "link",
      sourceUrl: claimed.sourceUrl,
      originalImageKey: originalKey,
      cutoutImageKey: cutoutKey,
      originalUrl,
      cutoutUrl,
      suggestedTags,
    };
  } catch (error) {
    // The original stays: it belongs to the import, and the cleanup job
    // removes it if no item ever uses it.
    await removeCutout();
    // AI paused before the tagging call: nothing was tagged, so give the
    // count back and reopen the import, so the user can finish it later
    // (inside its hour) without pasting the link again.
    if (isAiPausedError(error)) {
      await counted.cancel().catch(() => {});
      await deps.linkImports.release(userId, originalKey).catch(() => {});
    }
    throw error;
  }
}

/**
 * Step 2 of a batch add (several links pasted at once; `saveForReview` in
 * the meta). Same steps as finishLinkImport, then the item is saved
 * straight away with its suggested tags and marked "to review". If tagging
 * failed twice there are no tags to save, so the draft comes back for the
 * review list to show (CONTRACTS.md section 5, "Several links at once").
 *
 * Caps for a batch: the phone runs the links one after another. Step 1
 * checks the item cap before fetching anything (and counts a link fetch),
 * and this step counts the item, so once today's items are used up the
 * next link's step 1 answers 429 items_per_day without fetching, and the
 * phone stops there.
 */
export async function finishLinkImportForReview(deps: LinkCutoutDeps, userId: string, upload: LinkCutoutUpload): Promise<BatchAddResponse> {
  const draft = await finishLinkImport(deps, userId, upload);
  const tags = draft.suggestedTags;
  if (!tags) return { status: "draft", draft };

  let row;
  try {
    row = await deps.reviewItems.create(userId, {
      source: "link",
      sourceUrl: draft.sourceUrl,
      originalImageKey: draft.originalImageKey,
      cutoutImageKey: draft.cutoutImageKey,
      tags,
      needsPhoto: false,
    });
  } catch (error) {
    if (error instanceof DuplicateImageKeyError) throw new ApiException("bad_request", "That item has already been saved");
    throw error;
  }
  const [item] = await toWardrobeItems(deps.storage, [row]);
  if (!item) throw new Error("Couldn't sign the new item's image URL");
  return { status: "saved", item };
}
