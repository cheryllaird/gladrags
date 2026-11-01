/**
 * The get-started checklist (spec: Getting started): shown instead of an
 * empty grid on a new or nearly empty wardrobe, until the user has a few
 * items in each main category, or dismisses it.
 *
 * Rules (pure, so they're unit-tested):
 * - "A few" is FEW_ITEMS (3). The main categories are tops, bottoms and
 *   shoes; a dress or jumpsuit counts towards both tops and bottoms, since
 *   it fills both slots of an outfit. Outerwear is optional.
 * - Step 2, "Add several at once", is done once a batch add saved
 *   something on this device, or an item added in a batch (photo or link)
 *   is still waiting for review.
 *
 * What's remembered (dismissed, added several) is per user and per
 * device, in localStorage, and every access is wrapped: with storage
 * blocked the checklist just shows until the wardrobe is stocked.
 */
import type { WardrobeItem } from "@/contracts";
import { notifyStorageChange } from "@/lib/client/use-storage-value";

export const FEW_ITEMS = 3;

export type ChecklistStepId = "first_item" | "several" | "email" | "outfit";

export interface ChecklistStep {
  id: ChecklistStepId;
  title: string;
  description: string;
  href: string;
  done: boolean;
}

/** True once there are a few tops, bottoms and pairs of shoes: the checklist has done its job. */
export function wardrobeIsStocked(items: readonly Pick<WardrobeItem, "tags">[]): boolean {
  const count = (test: (category: string) => boolean) => items.filter((item) => test(item.tags.category)).length;
  const tops = count((c) => c === "top" || c === "dress_jumpsuit");
  const bottoms = count((c) => c === "bottom" || c === "dress_jumpsuit");
  const shoes = count((c) => c === "shoes");
  return tops >= FEW_ITEMS && bottoms >= FEW_ITEMS && shoes >= FEW_ITEMS;
}

export function checklistSteps(input: {
  items: readonly Pick<WardrobeItem, "source" | "needsReview">[];
  addedSeveral: boolean;
  hasOutfit: boolean;
}): ChecklistStep[] {
  const { items } = input;
  return [
    {
      id: "first_item",
      title: "Add your first item",
      description: "Take a photo of something you wear a lot, or paste a link to it.",
      href: "/add",
      done: items.length > 0,
    },
    {
      id: "several",
      title: "Add several at once",
      description: "Choose several photos from your library, or paste a few product links together.",
      href: "/add",
      done: input.addedSeveral || items.some((item) => item.needsReview && item.source !== "email"),
    },
    {
      id: "email",
      title: "Forward an order email",
      description: "Forward order confirmations from your shops to your own GladRags address, and we add what you bought.",
      href: "/settings#order-emails",
      done: items.some((item) => item.source === "email"),
    },
    {
      id: "outfit",
      title: "Get your first outfit",
      description: "Outfits work from your first item: where something's missing, we suggest what to add.",
      href: "/outfits",
      done: input.hasOutfit,
    },
  ];
}

// ---------------------------------------------------------------------------
// Per user, per device
// ---------------------------------------------------------------------------

const KEY_PREFIX = "gladrags-checklist:";

export interface ChecklistMemory {
  dismissed: boolean;
  addedSeveral: boolean;
}

/** The localStorage key for this user's checklist memory on this device. */
export function checklistKey(userId: string | null): string | null {
  return userId ? `${KEY_PREFIX}${userId}` : null;
}

/** Parse what's stored (anything unexpected reads as nothing remembered). */
export function parseChecklistMemory(raw: string | null | undefined): ChecklistMemory {
  const empty = { dismissed: false, addedSeveral: false };
  if (!raw) return empty;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return empty;
    const value = parsed as Record<string, unknown>;
    return { dismissed: value.dismissed === true, addedSeveral: value.addedSeveral === true };
  } catch {
    return empty;
  }
}

export function readChecklistMemory(userId: string | null): ChecklistMemory {
  const key = checklistKey(userId);
  if (!key) return parseChecklistMemory(null);
  try {
    return parseChecklistMemory(window.localStorage.getItem(key));
  } catch {
    return parseChecklistMemory(null);
  }
}

function remember(userId: string | null, change: Partial<ChecklistMemory>): void {
  const key = checklistKey(userId);
  if (!key) return;
  try {
    const current = readChecklistMemory(userId);
    if (Object.entries(change).every(([field, value]) => current[field as keyof ChecklistMemory] === value)) return;
    window.localStorage.setItem(key, JSON.stringify({ ...current, ...change }));
  } catch {
    // Storage blocked: it's only a convenience.
  }
  notifyStorageChange();
}

/** "Hide this" on the checklist, for this user on this device. */
export function dismissChecklist(userId: string | null): void {
  remember(userId, { dismissed: true });
}

/** A batch add saved at least one item: step 2 is done. */
export function noteAddedSeveral(userId: string | null): void {
  remember(userId, { addedSeveral: true });
}
