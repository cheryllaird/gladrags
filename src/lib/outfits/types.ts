import type { ItemTags } from "@/contracts";

/** What the pure engine functions need from an item. */
export interface TaggedItem {
  id: string;
  tags: ItemTags;
}

/** Where an item's picture is stored. Thumbnails use the cut-out, or the original when there isn't one. */
export interface ImageRef {
  bucket: "cutouts" | "originals";
  key: string;
}

/** A wardrobe item as the engine loads it: tags plus where to find its picture. */
export interface WardrobeEntry extends TaggedItem {
  image: ImageRef;
}

/** One outfit the model picked, after validation. */
export interface RankedOutfit {
  itemIds: string[];
  name: string;
  reason: string;
}
