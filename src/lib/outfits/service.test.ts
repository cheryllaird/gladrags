import { beforeEach, describe, expect, it } from "vitest";
import { OutfitSchema, checkComposition, type Outfit, type OutfitGenerationResponse } from "@/contracts";
import type { FinalPickInput, ModelCall, RankingProvider, ShortlistInput } from "@/lib/ai/types";
import { ApiException } from "@/lib/api/errors";
import { MOCK_USER } from "@/lib/auth/session";
import { MOCK_ITEMS } from "@/lib/mocks/fixtures";
import * as mock from "@/lib/mocks/store";
import { CapReachedError, DAILY_CAPS, InMemoryUsageStore, MONTHLY_AI_SPEND_CAP_PENCE, UsageGuard } from "@/lib/usage";
import { seededRandom } from "./candidates";
import { MockRankingProvider } from "./mock-ranking";
import { MockOutfitRepository } from "./mock-repository";
import { OutfitService, combineGuidance, incompleteMessage } from "./service";
import { PlaceholderThumbnailSource } from "./thumbnails";

const USER = MOCK_USER.id;
const NOW = new Date("2026-10-25T12:00:00Z"); // autumn
const byDescription = (text: string) => MOCK_ITEMS.find((i) => i.tags.description.includes(text))!;
const LOAFERS = byDescription("loafers");
const COAT = byDescription("Camel");

/** The mock ranker, keeping every input it was given. */
class RecordingRanking implements RankingProvider {
  readonly name = "recording";
  readonly shortlists: ShortlistInput[] = [];
  readonly finals: FinalPickInput[] = [];
  private readonly inner = new MockRankingProvider();

  shortlist(input: ShortlistInput): Promise<ModelCall> {
    this.shortlists.push(input);
    return this.inner.shortlist(input);
  }

  pickFinal(input: FinalPickInput): Promise<ModelCall> {
    this.finals.push(input);
    return this.inner.pickFinal(input);
  }
}

let store: InMemoryUsageStore;
let ranking: RecordingRanking;
let service: OutfitService;

beforeEach(() => {
  mock.resetMockStore();
  store = new InMemoryUsageStore(() => NOW);
  ranking = new RecordingRanking();
  service = new OutfitService({
    repository: new MockOutfitRepository(),
    ranking: () => ranking,
    thumbnails: new PlaceholderThumbnailSource(),
    usage: new UsageGuard(store, undefined, () => NOW),
    random: seededRandom(11),
    now: () => NOW,
  });
});

const count = (kind: string) => store.events.filter((e) => e.kind === kind).length;

function ok(response: OutfitGenerationResponse): Outfit[] {
  if (response.status !== "ok") throw new Error(`expected outfits, got ${response.reason}`);
  return response.outfits;
}

function expectWearable(outfits: Outfit[]) {
  for (const outfit of outfits) {
    expect(OutfitSchema.parse(outfit)).toEqual(outfit);
    expect(checkComposition(outfit.items.map((i) => i.tags.category))).toEqual({ ok: true });
    expect(outfit.items.map((i) => i.id)).toEqual(outfit.itemIds);
  }
}

describe("generate", () => {
  it("returns and saves outfits with the request, and counts usage", async () => {
    const outfits = ok(await service.generate(USER, { style: { kind: "preset", presetId: "work" }, count: 4 }));
    expect(outfits).toHaveLength(4);
    expectWearable(outfits);
    for (const o of outfits) {
      expect(o).toMatchObject({ status: "suggested", parentOutfitId: null, request: { style: { kind: "preset", presetId: "work" }, guidance: null, anchorItemId: null } });
      expect(mock.getOutfit(o.id)).toEqual(o);
    }
    expect(count("outfit_request")).toBe(1);
    expect(count("ranking_shortlist") + count("ranking_final")).toBeGreaterThanOrEqual(1);
  });

  it("builds every outfit around the anchor", async () => {
    const outfits = ok(await service.generate(USER, { style: { kind: "preset", presetId: "smart_casual" }, anchorItemId: COAT.id, count: 3 }));
    for (const o of outfits) expect(o.itemIds).toContain(COAT.id);
    expect(outfits[0]!.request.anchorItemId).toBe(COAT.id);
  });

  it("returns 404 for an anchor that isn't in the wardrobe, without counting", async () => {
    const error = await service
      .generate(USER, { style: { kind: "preset", presetId: "work" }, anchorItemId: "9f000000-0000-4000-8000-000000000000", count: 4 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiException);
    expect((error as ApiException).code).toBe("not_found");
    expect(count("outfit_request")).toBe(0);
  });

  it("says which category is missing, without counting the request", async () => {
    for (const item of MOCK_ITEMS.filter((i) => i.tags.category === "shoes")) mock.deleteItem(item.id);
    const response = await service.generate(USER, { style: { kind: "preset", presetId: "casual" }, count: 4 });
    expect(response).toEqual({
      status: "incomplete_wardrobe",
      reason: "missing_category",
      missingCategories: ["shoes"],
      message: "Add shoes to your wardrobe to get outfits.",
    });
    expect(count("outfit_request")).toBe(0);
    expect(ranking.finals).toHaveLength(0);
  });

  it("says nothing fits when no combination suits the style", async () => {
    // Comfy (1): remove everything casual, leaving only items at 3 or above.
    for (const item of MOCK_ITEMS.filter((i) => i.tags.formality <= 2)) mock.deleteItem(item.id);
    const response = await service.generate(USER, { style: { kind: "preset", presetId: "comfy" }, count: 3 });
    expect(response).toMatchObject({ status: "incomplete_wardrobe", reason: "nothing_fits", missingCategories: [] });
    expect(response.status !== "ok" && response.message).toContain("comfy");
    expect(count("outfit_request")).toBe(0);
  });
});

describe("caps", () => {
  it("refuses a new request once today's cap is used up", async () => {
    for (let i = 0; i < DAILY_CAPS.outfit_request; i++) await store.record({ userId: USER, kind: "outfit_request", costPence: 0, provider: null });
    const error = await service.generate(USER, { style: { kind: "preset", presetId: "work" }, count: 3 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CapReachedError);
    expect((error as CapReachedError).cap).toBe("outfit_requests_per_day");
    expect(ranking.shortlists).toHaveLength(0);
  });

  it("counts refinements against the same cap", async () => {
    const [outfit] = ok(await service.generate(USER, { style: { kind: "preset", presetId: "work" }, count: 3 }));
    await service.refine(USER, outfit!.id, { kind: "guidance", text: "warmer" });
    expect(count("outfit_request")).toBe(2);
    for (let i = 2; i < DAILY_CAPS.outfit_request; i++) await store.record({ userId: USER, kind: "outfit_request", costPence: 0, provider: null });
    await expect(service.refine(USER, outfit!.id, { kind: "guidance", text: "cooler" })).rejects.toBeInstanceOf(CapReachedError);
  });

  it("pauses new outfits and refinements when the monthly AI cap is reached, but not browsing or saving", async () => {
    const [outfit] = ok(await service.generate(USER, { style: { kind: "preset", presetId: "work" }, count: 3 }));
    await store.record({ userId: null, kind: "tagging", costPence: MONTHLY_AI_SPEND_CAP_PENCE, provider: "gemini" });

    const paused = await service.generate(USER, { style: { kind: "preset", presetId: "work" }, count: 3 }).catch((e: unknown) => e);
    expect((paused as CapReachedError).cap).toBe("monthly_ai_spend");
    const refinePaused = await service.refine(USER, outfit!.id, { kind: "guidance", text: "warmer" }).catch((e: unknown) => e);
    expect((refinePaused as CapReachedError).cap).toBe("monthly_ai_spend");

    expect(await service.list(USER)).toHaveLength(3);
    expect((await service.updateStatus(USER, outfit!.id, { status: "saved" })).status).toBe("saved");
  });

  it("records the cost of every model call", async () => {
    await service.generate(USER, { style: { kind: "preset", presetId: "work" }, count: 3 });
    const costed = store.events.filter((e) => e.kind === "ranking_shortlist" || e.kind === "ranking_final");
    expect(costed.length).toBe(ranking.shortlists.length + ranking.finals.length);
    expect(costed.every((e) => e.userId === USER && e.provider === "mock")).toBe(true);
  });
});

describe("refine", () => {
  let parent: Outfit;

  beforeEach(async () => {
    [parent] = ok(await service.generate(USER, { style: { kind: "preset", presetId: "smart_casual" }, guidance: "no heels", count: 3 })) as [Outfit];
  });

  it("swap: records feedback, links to the parent, keeps the rest and drops the swapped item", async () => {
    const shoes = parent.items.find((i) => i.tags.category === "shoes")!;
    const outfits = ok(await service.refine(USER, parent.id, { kind: "swap", itemId: shoes.id }));
    expectWearable(outfits);
    const kept = parent.itemIds.filter((id) => id !== shoes.id && mock.getItem(id)!.tags.category !== "outerwear");
    for (const o of outfits) {
      expect(o.parentOutfitId).toBe(parent.id);
      expect(o.itemIds).not.toContain(shoes.id);
      expect(o.itemIds).toEqual(expect.arrayContaining(kept));
      expect(o.request).toEqual(parent.request);
    }
    expect(mock.listOutfitFeedback()).toEqual([expect.objectContaining({ outfitId: parent.id, kind: "swap", detail: shoes.id })]);
    const pass2 = ranking.finals.at(-1)!;
    expect(pass2.refinement).toEqual({ previousItemIds: parent.itemIds, feedback: { kind: "swap", itemId: shoes.id } });
  });

  it("guidance: records feedback, adds to the earlier guidance, and doesn't return the same outfit", async () => {
    const outfits = ok(await service.refine(USER, parent.id, { kind: "guidance", text: "warmer" }));
    const key = (ids: string[]) => [...ids].sort().join();
    for (const o of outfits) {
      expect(o.parentOutfitId).toBe(parent.id);
      expect(o.request.guidance).toBe("no heels; warmer");
      expect(key(o.itemIds)).not.toBe(key(parent.itemIds));
    }
    expect(mock.listOutfitFeedback()).toEqual([expect.objectContaining({ kind: "guidance", detail: "warmer" })]);
    expect(ranking.finals.at(-1)!.request.guidance).toBe("no heels; warmer");
  });

  it("refuses to swap an item that isn't in the outfit, without counting", async () => {
    const other = MOCK_ITEMS.find((i) => !parent.itemIds.includes(i.id))!;
    const error = await service.refine(USER, parent.id, { kind: "swap", itemId: other.id }).catch((e: unknown) => e);
    expect((error as ApiException).code).toBe("bad_request");
    expect(count("outfit_request")).toBe(1);
    expect(mock.listOutfitFeedback()).toEqual([]);
  });

  it("returns 404 for an unknown outfit", async () => {
    const error = await service.refine(USER, "9f000000-0000-4000-8000-000000000000", { kind: "guidance", text: "x" }).catch((e: unknown) => e);
    expect((error as ApiException).code).toBe("not_found");
  });

  it("drops the anchor when it's the item swapped out", async () => {
    const [anchored] = ok(await service.generate(USER, { style: { kind: "preset", presetId: "smart_casual" }, anchorItemId: LOAFERS.id, count: 3 }));
    const outfits = ok(await service.refine(USER, anchored!.id, { kind: "swap", itemId: LOAFERS.id }));
    for (const o of outfits) {
      expect(o.itemIds).not.toContain(LOAFERS.id);
      expect(o.request.anchorItemId).toBeNull();
    }
  });

  it("says what's missing when the swapped item was the only one of its kind", async () => {
    for (const item of MOCK_ITEMS.filter((i) => i.tags.category === "shoes" && !parent.itemIds.includes(i.id))) mock.deleteItem(item.id);
    const shoes = parent.items.find((i) => i.tags.category === "shoes")!;
    const response = await service.refine(USER, parent.id, { kind: "swap", itemId: shoes.id });
    expect(response).toMatchObject({ status: "incomplete_wardrobe", reason: "missing_category", missingCategories: ["shoes"] });
  });
});

describe("status and avoid hints", () => {
  it("saves, likes and rejects; a rejection records feedback once", async () => {
    const [a, b] = ok(await service.generate(USER, { style: { kind: "preset", presetId: "work" }, count: 3 }));
    expect((await service.updateStatus(USER, a!.id, { status: "saved" })).status).toBe("saved");
    expect((await service.updateStatus(USER, a!.id, { status: "liked" })).status).toBe("liked");
    await service.updateStatus(USER, b!.id, { status: "rejected", reason: "too formal" });
    await service.updateStatus(USER, b!.id, { status: "rejected" });
    expect(mock.listOutfitFeedback()).toEqual([expect.objectContaining({ outfitId: b!.id, kind: "reject", detail: "too formal" })]);
    expect((await service.list(USER, "rejected")).map((o) => o.id)).toEqual([b!.id]);
  });

  it("returns 404 when updating an unknown outfit", async () => {
    const error = await service.updateStatus(USER, "9f000000-0000-4000-8000-000000000000", { status: "saved" }).catch((e: unknown) => e);
    expect((error as ApiException).code).toBe("not_found");
  });

  it("sends rejected pairings as avoid hints on later requests, and never suggests the rejected outfit again", async () => {
    const [rejected] = ok(await service.generate(USER, { style: { kind: "preset", presetId: "work" }, count: 3 }));
    await service.updateStatus(USER, rejected!.id, { status: "rejected" });

    const key = (ids: string[]) => [...ids].sort().join();
    for (let i = 0; i < 5; i++) {
      const outfits = ok(await service.generate(USER, { style: { kind: "preset", presetId: "work" }, count: 3 }));
      for (const o of outfits) expect(key(o.itemIds)).not.toBe(key(rejected!.itemIds));
    }
    const lastContext = ranking.finals.at(-1)!;
    const pairKeys = lastContext.avoidPairs.map(([x, y]) => [x, y].sort().join());
    expect(pairKeys).toContain([rejected!.itemIds[0]!, rejected!.itemIds[1]!].sort().join());
  });

  it("a rejected outfit that's later saved stops being an avoid hint", async () => {
    const [outfit] = ok(await service.generate(USER, { style: { kind: "preset", presetId: "work" }, count: 3 }));
    await service.updateStatus(USER, outfit!.id, { status: "rejected" });
    await service.updateStatus(USER, outfit!.id, { status: "saved" });
    await service.generate(USER, { style: { kind: "preset", presetId: "work" }, count: 3 });
    expect(ranking.finals.at(-1)!.avoidPairs).toEqual([]);
  });
});

describe("messages and helpers", () => {
  it("words the incomplete-wardrobe messages", () => {
    const work = { kind: "preset", presetId: "work" } as const;
    expect(incompleteMessage({ status: "incomplete_wardrobe", reason: "missing_category", missingCategories: ["top", "bottom", "shoes"] }, work, false)).toBe(
      "Add a top, a bottom and shoes to your wardrobe to get outfits.",
    );
    expect(incompleteMessage({ status: "incomplete_wardrobe", reason: "missing_category", missingCategories: ["bottom"] }, work, true)).toBe(
      "To build an outfit around this item, add a bottom to your wardrobe.",
    );
    expect(incompleteMessage({ status: "incomplete_wardrobe", reason: "nothing_fits", missingCategories: [] }, { kind: "custom", text: "Gig" }, false)).toBe(
      'Nothing in your wardrobe suits "Gig" yet. Try another style, or add more items.',
    );
  });

  it("combines guidance while it fits on one line", () => {
    expect(combineGuidance(null, "warmer")).toBe("warmer");
    expect(combineGuidance("no heels", "warmer")).toBe("no heels; warmer");
    expect(combineGuidance("x".repeat(195), "warmer")).toBe("warmer");
  });
});
