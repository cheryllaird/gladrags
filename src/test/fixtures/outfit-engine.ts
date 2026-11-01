/**
 * A test wardrobe and recorded-style ranking replies for outfit-engine
 * tests, good and bad. Objects are what a provider hands back after JSON
 * parsing; strings are raw model text.
 */
import { uuid, wardrobe } from "@/test/outfit-helpers";

/** 3 tops, 3 bottoms, 2 shoes, 1 outerwear, 1 dress: 40 combinations, so pass 1 runs. */
export const WARDROBE = wardrobe({ top: 3, bottom: 3, shoes: 2, outerwear: 1, dress_jumpsuit: 1 });

export const W = {
  top1: uuid(1),
  top2: uuid(2),
  top3: uuid(3),
  bottom1: uuid(4),
  bottom2: uuid(5),
  bottom3: uuid(6),
  shoes1: uuid(7),
  shoes2: uuid(8),
  coat: uuid(9),
  dress: uuid(10),
};

/** An ID that looks real but isn't in the wardrobe. */
export const INVENTED_ID = "2b000000-0000-4000-8000-00000000dead";

export const shortlistReplies = {
  valid: {
    outfits: [
      { itemIds: [W.top1, W.bottom1, W.shoes1] },
      { itemIds: [W.top2, W.bottom2, W.shoes1, W.coat] },
      { itemIds: [W.dress, W.shoes2] },
      { itemIds: [W.top3, W.bottom3, W.shoes2] },
    ],
  },
  /** One outfit uses an item the wardrobe doesn't have. */
  inventedItemId: {
    outfits: [{ itemIds: [W.top1, W.bottom1, W.shoes1] }, { itemIds: [W.top2, INVENTED_ID, W.shoes1] }],
  },
  /** Built around the coat, but the second outfit leaves it out. */
  omitsAnchor: {
    outfits: [{ itemIds: [W.top1, W.bottom1, W.shoes1, W.coat] }, { itemIds: [W.dress, W.shoes2] }],
  },
  aroundCoat: {
    outfits: [
      { itemIds: [W.top1, W.bottom1, W.shoes1, W.coat] },
      { itemIds: [W.dress, W.shoes2, W.coat] },
      { itemIds: [W.top2, W.bottom3, W.shoes2, W.coat] },
    ],
  },
  /** Two tops: breaks the composition rule. */
  twoTops: { outfits: [{ itemIds: [W.top1, W.top2, W.bottom1, W.shoes1] }] },
  prose: "I'd go with the navy shirt, chinos and loafers.",
  truncated: '{"outfits":[{"itemIds":["2b000000-0000-4000-8000-000000000001",',
};

export const finalReplies = {
  valid: {
    outfits: [
      { itemIds: [W.top1, W.bottom1, W.shoes1], name: "Easy office", reason: "Navy and tan keep this smart without being stiff" },
      { itemIds: [W.dress, W.shoes2], name: "One and done", reason: "A dress and loafers is polished with no effort" },
      { itemIds: [W.top2, W.bottom2, W.shoes1, W.coat], name: "Layered up", reason: "The blazer adds structure for meetings" },
    ],
  },
  /** Five picks when three were asked for. */
  tooMany: {
    outfits: [
      { itemIds: [W.top1, W.bottom1, W.shoes1], name: "One", reason: "First" },
      { itemIds: [W.dress, W.shoes2], name: "Two", reason: "Second" },
      { itemIds: [W.top2, W.bottom2, W.shoes1, W.coat], name: "Three", reason: "Third" },
      { itemIds: [W.top3, W.bottom3, W.shoes2], name: "Four", reason: "Fourth" },
      { itemIds: [W.top1, W.bottom2, W.shoes2], name: "Five", reason: "Fifth" },
    ],
  },
  /** One good pick and one with an invented item ID. */
  inventedItemId: {
    outfits: [
      { itemIds: [W.top1, W.bottom1, W.shoes1], name: "Easy office", reason: "Navy and tan keep this smart" },
      { itemIds: [W.dress, INVENTED_ID], name: "Mystery", reason: "Uses an item that doesn't exist" },
    ],
  },
  /** Every pick uses an invented item. */
  allInvented: {
    outfits: [{ itemIds: [W.top1, W.bottom1, INVENTED_ID], name: "Mystery", reason: "Uses an item that doesn't exist" }],
  },
  /** Built around the coat, but leaves it out. */
  omitsAnchor: {
    outfits: [{ itemIds: [W.top1, W.bottom1, W.shoes1], name: "No coat", reason: "Forgot the anchor" }],
  },
  aroundCoat: {
    outfits: [
      { itemIds: [W.top1, W.bottom1, W.shoes1, W.coat], name: "Coat on", reason: "The coat pulls it together" },
      { itemIds: [W.dress, W.shoes2, W.coat], name: "Dress and coat", reason: "Warm enough for autumn" },
    ],
  },
  nameTooLong: {
    outfits: [
      {
        itemIds: [W.top1, W.bottom1, W.shoes1],
        name: "An extremely long outfit name that goes on and on",
        reason: "Too long a name",
      },
    ],
  },
};

/**
 * The pipeline's "ok" result for these picks: each outfit with its gaps
 * (none unless given) and the wardrobe's missing categories (none unless
 * given).
 */
export function okResult(outfits: readonly ({ itemIds: string[]; name: string; reason: string } & { gaps?: unknown[] })[], missingCategories: string[] = []) {
  return { status: "ok", outfits: outfits.map((o) => ({ ...o, gaps: o.gaps ?? [] })), missingCategories };
}
