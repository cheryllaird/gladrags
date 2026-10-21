/**
 * In-memory data for mock mode, so the UI agents can build complete flows
 * (add an item, see it in the grid, get outfits, save one) before the real
 * backend exists. The API route stubs serve this data until their owning
 * agents replace them with real implementations.
 *
 * Outfit "generation" here is deliberately naive (first valid combos). The
 * real pipeline belongs to outfit-engine in src/lib/outfits/.
 */
import {
  missingCategoriesForOutfits,
  type Category,
  type CreateItemRequest,
  type ItemDraft,
  type ItemListQuery,
  type ItemTags,
  type Outfit,
  type OutfitGenerationResponse,
  type OutfitRequest,
  type OutfitStatus,
  type RefineRequest,
  type StoredOutfitRequest,
  type WardrobeItem,
} from "@/contracts";
import { MOCK_USER } from "@/lib/auth/session";
import { MOCK_ITEMS, MOCK_OUTFIT_COPY, MOCK_SUGGESTED_TAGS, MOCK_UPLOAD_IMAGE_URL } from "./fixtures";

interface MockState {
  items: Map<string, WardrobeItem>;
  outfits: Map<string, Outfit>;
  /** Image key -> URL for drafts that haven't been saved yet. */
  draftImages: Map<string, string>;
  /** Rotates which combinations come back, so refining gives a new set. */
  generation: number;
}

function freshState(): MockState {
  return {
    items: new Map(MOCK_ITEMS.map((item) => [item.id, structuredClone(item)])),
    outfits: new Map(),
    draftImages: new Map(),
    generation: 0,
  };
}

// On globalThis so data survives dev-server hot reloads.
const globalForMocks = globalThis as unknown as { __gladragsMockState?: MockState };

function state(): MockState {
  globalForMocks.__gladragsMockState ??= freshState();
  return globalForMocks.__gladragsMockState;
}

/** Back to the fixture wardrobe with no outfits. For tests. */
export function resetMockStore(): void {
  globalForMocks.__gladragsMockState = freshState();
}

const now = () => new Date().toISOString();
const clone = <T>(value: T): T => structuredClone(value);

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

export function listItems(query: ItemListQuery = {}): WardrobeItem[] {
  const q = query.q?.toLowerCase();
  return [...state().items.values()]
    .filter((item) => !query.category || item.tags.category === query.category)
    .filter((item) => !query.colour || item.tags.colours.includes(query.colour))
    .filter((item) => !query.occasion || item.tags.occasions.includes(query.occasion))
    .filter((item) => !q || item.tags.description.toLowerCase().includes(q))
    .map(clone);
}

export function getItem(id: string): WardrobeItem | null {
  const item = state().items.get(id);
  return item ? clone(item) : null;
}

/** A new image key in the mock user's folder. */
function newImageKey(ext: "jpg" | "png"): string {
  const key = `${MOCK_USER.id}/${crypto.randomUUID()}.${ext}`;
  state().draftImages.set(key, MOCK_UPLOAD_IMAGE_URL);
  return key;
}

/**
 * What the photo route (and link step 2) return in mock mode. Pass the
 * original's key when it was already stored (link step 1).
 */
export function createDraft(options: {
  source: "photo" | "link";
  sourceUrl: string | null;
  hasCutout: boolean;
  originalImageKey?: string;
}): ItemDraft {
  const originalImageKey = options.originalImageKey ?? newImageKey("jpg");
  const cutoutImageKey = options.hasCutout ? newImageKey("png") : null;
  return {
    source: options.source,
    sourceUrl: options.sourceUrl,
    originalImageKey,
    cutoutImageKey,
    originalUrl: MOCK_UPLOAD_IMAGE_URL,
    cutoutUrl: cutoutImageKey ? MOCK_UPLOAD_IMAGE_URL : null,
    suggestedTags: clone(MOCK_SUGGESTED_TAGS),
  };
}

/** Link step 1 in mock mode: "store" the product image as the original. */
export function storeLinkImage(): { originalImageKey: string; originalUrl: string } {
  return { originalImageKey: newImageKey("jpg"), originalUrl: MOCK_UPLOAD_IMAGE_URL };
}

export function createItem(req: CreateItemRequest): WardrobeItem {
  const s = state();
  const item: WardrobeItem = {
    id: crypto.randomUUID(),
    source: req.source,
    sourceUrl: req.sourceUrl,
    originalUrl: s.draftImages.get(req.originalImageKey) ?? MOCK_UPLOAD_IMAGE_URL,
    cutoutUrl: req.cutoutImageKey ? (s.draftImages.get(req.cutoutImageKey) ?? MOCK_UPLOAD_IMAGE_URL) : null,
    tags: clone(req.tags),
    tagsEdited: req.tagsEdited,
    createdAt: now(),
  };
  s.items.set(item.id, item);
  return clone(item);
}

export function updateItemTags(id: string, tags: ItemTags): WardrobeItem | null {
  const item = state().items.get(id);
  if (!item) return null;
  item.tags = clone(tags);
  item.tagsEdited = true;
  return clone(item);
}

/** Also removes outfits that used the item, as the database trigger does. */
export function deleteItem(id: string): boolean {
  const s = state();
  if (!s.items.delete(id)) return false;
  for (const [outfitId, outfit] of s.outfits) {
    if (outfit.itemIds.includes(id)) s.outfits.delete(outfitId);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Outfits
// ---------------------------------------------------------------------------

export function listOutfits(status?: OutfitStatus): Outfit[] {
  return [...state().outfits.values()]
    .filter((o) => !status || o.status === status)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(clone);
}

export function getOutfit(id: string): Outfit | null {
  const outfit = state().outfits.get(id);
  return outfit ? clone(outfit) : null;
}

export function setOutfitStatus(id: string, status: OutfitStatus): Outfit | null {
  const outfit = state().outfits.get(id);
  if (!outfit) return null;
  outfit.status = status;
  return clone(outfit);
}

function byCategory(items: WardrobeItem[], category: Category) {
  return items.filter((i) => i.tags.category === category);
}

/** Every top+bottom and dress, with each pair of shoes; outerwear on alternate combos. */
function naiveCombinations(items: WardrobeItem[]): WardrobeItem[][] {
  const bodies: WardrobeItem[][] = [];
  for (const top of byCategory(items, "top")) {
    for (const bottom of byCategory(items, "bottom")) bodies.push([top, bottom]);
  }
  for (const dress of byCategory(items, "dress_jumpsuit")) bodies.push([dress]);

  const outerwear = byCategory(items, "outerwear");
  const combos: WardrobeItem[][] = [];
  for (const body of bodies) {
    for (const shoes of byCategory(items, "shoes")) {
      const layer = outerwear.length > 0 && combos.length % 2 === 1 ? outerwear[combos.length % outerwear.length] : undefined;
      combos.push(layer ? [...body, shoes, layer] : [...body, shoes]);
    }
  }
  return combos;
}

function generate(
  request: StoredOutfitRequest,
  count: number,
  parentOutfitId: string | null,
  exclude: ReadonlySet<string> = new Set(),
): OutfitGenerationResponse {
  const s = state();
  const items = [...s.items.values()].filter((i) => !exclude.has(i.id));
  const missing = missingCategoriesForOutfits(new Set(items.map((i) => i.tags.category)));
  if (missing.length > 0) {
    return {
      status: "incomplete_wardrobe",
      reason: "missing_category",
      missingCategories: missing,
      message: `Add ${missing.join(" and ")} to your wardrobe to get outfits.`,
    };
  }

  let combos = naiveCombinations(items);
  const anchorId = request.anchorItemId;
  if (anchorId) {
    const anchor = s.items.get(anchorId);
    if (anchor?.tags.category === "outerwear") {
      combos = combos.map((c) => [...c.filter((i) => i.tags.category !== "outerwear"), anchor]);
    } else {
      combos = combos.filter((c) => c.some((i) => i.id === anchorId));
    }
  }
  if (combos.length === 0) {
    return {
      status: "incomplete_wardrobe",
      reason: "nothing_fits",
      missingCategories: [],
      message: "Nothing in your wardrobe works with that yet. Try another style or item.",
    };
  }

  const start = (s.generation++ * count) % combos.length;
  const picked = Array.from({ length: Math.min(count, combos.length) }, (_, i) => combos[(start + i) % combos.length]!);

  const outfits = picked.map((combo, i): Outfit => {
    const copy = MOCK_OUTFIT_COPY[(start + i) % MOCK_OUTFIT_COPY.length]!;
    const outfit: Outfit = {
      id: crypto.randomUUID(),
      request: clone(request),
      name: copy.name,
      reason: copy.reason,
      itemIds: combo.map((item) => item.id),
      items: combo.map(clone),
      status: "suggested",
      parentOutfitId,
      createdAt: now(),
    };
    s.outfits.set(outfit.id, outfit);
    return clone(outfit);
  });
  return { status: "ok", outfits };
}

export function generateOutfits(request: OutfitRequest): OutfitGenerationResponse {
  return generate(
    { style: request.style, guidance: request.guidance ?? null, anchorItemId: request.anchorItemId ?? null },
    request.count,
    null,
  );
}

/** Returns null if the outfit doesn't exist. */
export function refineOutfit(outfitId: string, refine: RefineRequest): OutfitGenerationResponse | null {
  const parent = state().outfits.get(outfitId);
  if (!parent) return null;
  const request: StoredOutfitRequest = {
    ...parent.request,
    guidance: refine.kind === "guidance" ? refine.text : parent.request.guidance,
  };
  const exclude = refine.kind === "swap" ? new Set([refine.itemId]) : new Set<string>();
  return generate(request, 3, parent.id, exclude);
}
