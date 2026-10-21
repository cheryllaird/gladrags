/**
 * Convert database rows (snake_case) to API shapes (camelCase) and back.
 * Image URLs are passed in because signing them needs a Supabase call.
 */
import type { CreateItemRequest, ItemRow, ItemTags, Outfit, OutfitRow, WardrobeItem } from "@/contracts";

export function itemRowToWardrobeItem(row: ItemRow, urls: { originalUrl: string; cutoutUrl: string }): WardrobeItem {
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

/** `itemsById` must contain every item in row.item_ids. */
export function outfitRowToOutfit(row: OutfitRow, itemsById: ReadonlyMap<string, WardrobeItem>): Outfit {
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
    status: row.status,
    parentOutfitId: row.parent_outfit_id,
    createdAt: new Date(row.created_at).toISOString(),
  };
}
