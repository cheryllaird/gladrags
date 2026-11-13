/**
 * Convert database rows (snake_case) to API shapes (camelCase) and back.
 * Image URLs are passed in because signing them needs a Supabase call.
 */
import {
  NO_PREVIEW,
  type CreateItemRequest,
  type ItemRow,
  type ItemTags,
  type Outfit,
  type OutfitPreview,
  type OutfitPreviewRow,
  type OutfitRow,
  type WardrobeItem,
} from "@/contracts";

/** Pass cutoutUrl: null when the row has no cutout_image_key. */
export function itemRowToWardrobeItem(
  row: ItemRow,
  urls: { originalUrl: string; cutoutUrl: string | null },
): WardrobeItem {
  return {
    id: row.id,
    source: row.source,
    sourceUrl: row.source_url,
    originalUrl: urls.originalUrl,
    cutoutUrl: urls.cutoutUrl,
    tags: {
      category: row.category,
      subcategory: row.subcategory,
      colours: row.colours,
      pattern: row.pattern,
      formality: row.formality,
      seasons: row.seasons,
      warmth: row.warmth,
      occasions: row.occasions,
      fabric: row.fabric,
      description: row.description,
    },
    tagsEdited: row.tags_edited,
    needsReview: row.needs_review,
    needsPhoto: row.needs_photo,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

/** Columns for an items insert or update from a set of tags. */
export function tagsToItemColumns(tags: ItemTags) {
  return {
    category: tags.category,
    subcategory: tags.subcategory,
    colours: tags.colours,
    pattern: tags.pattern,
    formality: tags.formality,
    seasons: tags.seasons,
    warmth: tags.warmth,
    occasions: tags.occasions,
    fabric: tags.fabric,
    description: tags.description,
  };
}

export function createItemRequestToRow(userId: string, req: CreateItemRequest) {
  return {
    user_id: userId,
    source: req.source,
    source_url: req.sourceUrl,
    original_image_key: req.originalImageKey,
    cutout_image_key: req.cutoutImageKey,
    tags_edited: req.tagsEdited,
    ...tagsToItemColumns(req.tags),
  };
}

/**
 * Round 2: the API preview for an outfit row and its outfit_previews row
 * (null when outfits.preview_id is null). Pass the signed URL of a ready
 * image; a ready row whose image can't be signed reads as failed (internal).
 */
export function previewRowToOutfitPreview(
  outfit: Pick<OutfitRow, "preview_outdated">,
  preview: OutfitPreviewRow | null,
  imageUrl: string | null,
): OutfitPreview {
  if (!preview) return { ...NO_PREVIEW, suggestedSlots: [] };
  const common = { presetId: preview.preset_id, suggestedSlots: [...preview.suggested_slots], outdated: outfit.preview_outdated };
  if (preview.status === "ready") {
    return imageUrl
      ? { status: "ready", imageUrl, failureReason: null, ...common }
      : { status: "failed", imageUrl: null, failureReason: "internal", ...common };
  }
  if (preview.status === "pending") return { status: "pending", imageUrl: null, failureReason: null, ...common };
  return { status: preview.status, imageUrl: null, failureReason: preview.failure_reason, ...common };
}

/**
 * `itemsById` must contain every item in row.item_ids. `preview` defaults
 * to none until the outfit engine reads outfit_previews (round 2, P2).
 */
export function outfitRowToOutfit(
  row: OutfitRow,
  itemsById: ReadonlyMap<string, WardrobeItem>,
  preview: OutfitPreview = { ...NO_PREVIEW, suggestedSlots: [] },
): Outfit {
  const items = row.item_ids.map((id) => {
    const item = itemsById.get(id);
    if (!item) throw new Error(`Outfit ${row.id} refers to missing item ${id}`);
    return item;
  });
  return {
    id: row.id,
    request: row.request,
    name: row.name,
    reason: row.reason,
    itemIds: row.item_ids,
    items,
    gaps: row.gaps,
    status: row.status,
    parentOutfitId: row.parent_outfit_id,
    createdAt: new Date(row.created_at).toISOString(),
    preview,
  };
}
