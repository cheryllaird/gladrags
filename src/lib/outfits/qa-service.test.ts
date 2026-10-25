/**
 * QA gap tests for the outfit service on the mock repository: refinement
 * (swap and guidance), feedback and avoid hints, and caps (counting and
 * costing failed requests, pauses that write nothing).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { GUIDANCE_MAX_LENGTH, type Outfit, type OutfitGenerationResponse } from "@/contracts";
import type { FinalPickInput, ModelCall, RankingProvider, ShortlistInput } from "@/lib/ai/types";
import { ApiException } from "@/lib/api/errors";
import { MOCK_USER } from "@/lib/auth/session";
import { MOCK_ITEMS } from "@/lib/mocks/fixtures";
import * as mock from "@/lib/mocks/store";
import { CapReachedError, DAILY_CAPS, ESTIMATED_COST_PENCE, InMemoryUsageStore, MONTHLY_AI_SPEND_CAP_PENCE, UsageGuard } from "@/lib/usage";
import { pairsOf, seededRandom } from "./candidates";
import { REFINE_COUNT } from "./config";
import { MockRankingProvider } from "./mock-ranking";
import { MockOutfitRepository } from "./mock-repository";
import { OutfitService } from "./service";
import { PlaceholderThumbnailSource } from "./thumbnails";

const USER = MOCK_USER.id;
const NOW = new Date("2026-10-25T12:00:00Z");
const SMART = { style: { kind: "preset", presetId: "smart_casual" }, count: 3 } as const;
const byDescription = (text: string) => MOCK_ITEMS.find((i) => i.tags.description.includes(text))!;

class RecordingRanking implements RankingProvider {
  readonly name = "recording";
  readonly shortlists: ShortlistInput[] = [];
  readonly finals: FinalPickInput[] = [];
  failWith: Error | null = null;
  private readonly inner = new MockRankingProvider();

  shortlist(input: ShortlistInput): Promise<ModelCall> {
    this.shortlists.push(input);
    if (this.failWith) return Promise.reject(this.failWith);
    return this.inner.shortlist(input);
  }

  pickFinal(input: FinalPickInput): Promise<ModelCall> {
    this.finals.push(input);
    if (this.failWith) return Promise.reject(this.failWith);
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
    random: seededRandom(5),
    now: () => NOW,
  });
});

const count = (kind: string) => store.events.filter((e) => e.kind === kind).length;
const key = (ids: readonly string[]) => [...ids].sort().join("+");

function ok(response: OutfitGenerationResponse): Outfit[] {
  if (response.status !== "ok") throw new Error(`expected outfits, got ${response.reason}`);
  return response.outfits;
}

/** Every item ID the model was shown in this request (both passes). */
function idsShownToModel(fromShortlist = 0, fromFinal = 0): Set<string> {
  const ids = new Set<string>();
  for (const s of ranking.shortlists.slice(fromShortlist)) {
    s.items.forEach((i) => ids.add(i.id));
    s.candidates.flat().forEach((id) => ids.add(id));
  }
  for (const f of ranking.finals.slice(fromFinal)) f.shortlist.forEach((o) => o.itemIds.forEach((id) => ids.add(id)));
  return ids;
}

describe("QA refine: swap", () => {
  it("never shows the swapped item to the model, keeps the other items, returns 3, links the parent, counts the cap", async () => {
    const [parent] = ok(await service.generate(USER, SMART));
    const top = parent!.items.find((i) => i.tags.category === "top" || i.tags.category === "dress_jumpsuit")!;
    const [s0, f0] = [ranking.shortlists.length, ranking.finals.length];

    const response = await service.refine(USER, parent!.id, { kind: "swap", itemId: top.id });
    const outfits = ok(response);

    expect(idsShownToModel(s0, f0).has(top.id)).toBe(false);
    expect(ranking.finals.at(-1)!.count).toBe(REFINE_COUNT);
    expect(REFINE_COUNT).toBe(3);
    expect(outfits.length).toBeLessThanOrEqual(3);
    const others = parent!.itemIds.filter((id) => id !== top.id);
    for (const o of outfits) {
      expect(o.itemIds).not.toContain(top.id);
      expect(o.parentOutfitId).toBe(parent!.id);
      expect(o.status).toBe("suggested");
      if (top.tags.category === "top") expect(o.itemIds).toEqual(expect.arrayContaining(others));
    }
    expect(count("outfit_request")).toBe(2);
  });

  it("a refinement of a refinement links to its own parent, not the original", async () => {
    const [first] = ok(await service.generate(USER, SMART));
    const [second] = ok(await service.refine(USER, first!.id, { kind: "guidance", text: "warmer" }));
    const [third] = ok(await service.refine(USER, second!.id, { kind: "guidance", text: "less formal" }));
    expect(second!.parentOutfitId).toBe(first!.id);
    expect(third!.parentOutfitId).toBe(second!.id);
  });

  it("swapping an item from an outfit that no longer has replacements falls back without the kept items, keeping the anchor", async () => {
    const jeans = byDescription("jeans");
    const [parent] = ok(await service.generate(USER, { ...SMART, anchorItemId: jeans.id }));
    const shoes = parent!.items.find((i) => i.tags.category === "shoes")!;
    const response = await service.refine(USER, parent!.id, { kind: "swap", itemId: shoes.id });
    if (response.status === "ok") {
      for (const o of response.outfits) {
        expect(o.itemIds).toContain(jeans.id);
        expect(o.itemIds).not.toContain(shoes.id);
        expect(o.request.anchorItemId).toBe(jeans.id);
      }
    } else {
      expect(response.reason).not.toBe("missing_category");
    }
  });
});

describe("QA refine: guidance", () => {
  it("keeps the anchor, returns 3 at most, never the parent outfit, and passes the previous outfit", async () => {
    const skirt = byDescription("skirt");
    const [parent] = ok(await service.generate(USER, { style: { kind: "preset", presetId: "work" }, anchorItemId: skirt.id, count: 3 }));
    const outfits = ok(await service.refine(USER, parent!.id, { kind: "guidance", text: "less formal" }));
    expect(outfits.length).toBeLessThanOrEqual(3);
    for (const o of outfits) {
      expect(o.itemIds).toContain(skirt.id);
      expect(key(o.itemIds)).not.toBe(key(parent!.itemIds));
      expect(o.request.anchorItemId).toBe(skirt.id);
    }
    expect(ranking.finals.at(-1)!.refinement).toEqual({
      previousItemIds: parent!.itemIds,
      feedback: { kind: "guidance", text: "less formal" },
    });
  });

  it("replaces the earlier guidance when the two together would be too long", async () => {
    const long = "x".repeat(GUIDANCE_MAX_LENGTH - 5);
    const [parent] = ok(await service.generate(USER, { ...SMART, guidance: long }));
    const [child] = ok(await service.refine(USER, parent!.id, { kind: "guidance", text: "warmer" }));
    expect(child!.request.guidance).toBe("warmer");
  });
});

describe("QA refine: caps and pauses write nothing", () => {
  it("AI paused: 503, no feedback row, nothing counted", async () => {
    const [parent] = ok(await service.generate(USER, SMART));
    const before = store.events.length;
    await store.record({ userId: null, kind: "tagging", costPence: MONTHLY_AI_SPEND_CAP_PENCE, provider: "gemini" });
    const error = await service.refine(USER, parent!.id, { kind: "swap", itemId: parent!.itemIds[0]! }).catch((e: unknown) => e);
    expect((error as CapReachedError).cap).toBe("monthly_ai_spend");
    expect(mock.listOutfitFeedback()).toEqual([]);
    expect(store.events.length).toBe(before + 1); // only the spend row the test added
  });

  it("daily cap: 429, no feedback row", async () => {
    const [parent] = ok(await service.generate(USER, SMART));
    for (let i = 1; i < DAILY_CAPS.outfit_request; i++) await store.record({ userId: USER, kind: "outfit_request", costPence: 0, provider: null });
    const error = await service.refine(USER, parent!.id, { kind: "guidance", text: "warmer" }).catch((e: unknown) => e);
    expect((error as CapReachedError).cap).toBe("outfit_requests_per_day");
    expect(mock.listOutfitFeedback()).toEqual([]);
  });

  it("the cap is per user: another user's requests don't use it up", async () => {
    for (let i = 0; i < DAILY_CAPS.outfit_request; i++) {
      await store.record({ userId: "0c000000-0000-4000-8000-0000000000ff", kind: "outfit_request", costPence: 0, provider: null });
    }
    await expect(service.generate(USER, SMART)).resolves.toMatchObject({ status: "ok" });
  });
});

describe("QA caps: counting and costing", () => {
  it("a counted request whose model calls all fail is still counted and costed at the estimate", async () => {
    ranking.failWith = new Error("timeout");
    const error = await service.generate(USER, { style: { kind: "preset", presetId: "work" }, count: 3 }).catch((e: unknown) => e);
    expect((error as ApiException).code).toBe("ai_failed");
    expect(count("outfit_request")).toBe(1);
    const costed = store.events.filter((e) => e.kind.startsWith("ranking_"));
    expect(costed.length).toBe(ranking.shortlists.length + ranking.finals.length);
    expect(costed.length).toBe(2);
    for (const e of costed) {
      expect(e.costPence).toBe(ESTIMATED_COST_PENCE[e.kind as "ranking_shortlist" | "ranking_final"]);
      expect(e.userId).toBe(USER);
    }
  });

  it("nothing_fits isn't counted or costed", async () => {
    // Formal event (4–5, loosened to 3–5): only the trainers (2) are left as shoes.
    mock.deleteItem(byDescription("courts").id);
    mock.deleteItem(byDescription("loafers").id);
    const response = await service.generate(USER, { style: { kind: "preset", presetId: "formal_event" }, count: 3 });
    expect(response).toMatchObject({ status: "incomplete_wardrobe", reason: "nothing_fits", missingCategories: [] });
    expect(count("outfit_request")).toBe(0);
    expect(store.events).toEqual([]);
  });

  it("an incomplete wardrobe from a refine isn't counted, though its feedback is kept", async () => {
    const [parent] = ok(await service.generate(USER, SMART));
    for (const item of MOCK_ITEMS.filter((i) => i.tags.category === "shoes" && !parent!.itemIds.includes(i.id))) mock.deleteItem(item.id);
    const shoes = parent!.items.find((i) => i.tags.category === "shoes")!;
    const response = await service.refine(USER, parent!.id, { kind: "swap", itemId: shoes.id });
    expect(response.status).toBe("incomplete_wardrobe");
    expect(count("outfit_request")).toBe(1);
  });
});

describe("QA missing category message is anchor-aware", () => {
  it("a top anchor with no bottoms but a dress asks for a bottom", async () => {
    for (const item of MOCK_ITEMS.filter((i) => i.tags.category === "bottom")) mock.deleteItem(item.id);
    const shirt = byDescription("oxford");
    const response = await service.generate(USER, { ...SMART, anchorItemId: shirt.id });
    expect(response).toEqual({
      status: "incomplete_wardrobe",
      reason: "missing_category",
      missingCategories: ["bottom"],
      message: "To build an outfit around this item, add a bottom to your wardrobe.",
    });
    // Without the anchor, the dress makes outfits.
    expect((await service.generate(USER, SMART)).status).not.toBe("incomplete_wardrobe");
  });

  it("no shoes at all, no anchor: asks for shoes", async () => {
    for (const item of MOCK_ITEMS.filter((i) => i.tags.category === "shoes")) mock.deleteItem(item.id);
    const response = await service.generate(USER, SMART);
    expect(response).toMatchObject({ reason: "missing_category", missingCategories: ["shoes"], message: "Add shoes to your wardrobe to get outfits." });
  });
});

describe("QA feedback: avoid hints come only from currently rejected outfits", () => {
  const pairKeys = (pairs: [string, string][]) => new Set(pairs.map(([a, b]) => key([a, b])));
  const lastHints = () => pairKeys(ranking.shortlists.at(-1)?.avoidPairs ?? ranking.finals.at(-1)!.avoidPairs);

  it("rejecting two, then undoing one, leaves only the other's pairs", async () => {
    const [a, b, c] = ok(await service.generate(USER, { style: { kind: "preset", presetId: "work" }, count: 3 }));
    await service.updateStatus(USER, a!.id, { status: "rejected" });
    await service.updateStatus(USER, b!.id, { status: "rejected", reason: "colours" });
    await service.updateStatus(USER, c!.id, { status: "liked" });
    await service.updateStatus(USER, a!.id, { status: "suggested" });

    await service.generate(USER, { style: { kind: "preset", presetId: "work" }, count: 3 });
    const hints = lastHints();
    const bPairs = pairsOf(b!.itemIds).map((p) => key(p));
    for (const p of hints) expect(bPairs).toContain(p);
    // a's pairs that aren't also in b are gone; liked c contributes nothing.
    for (const p of pairsOf(a!.itemIds).map((x) => key(x))) if (!bPairs.includes(p)) expect(hints.has(p)).toBe(false);
    for (const p of pairsOf(c!.itemIds).map((x) => key(x))) if (!bPairs.includes(p)) expect(hints.has(p)).toBe(false);
  });

  it("saved and liked outfits never become hints", async () => {
    const [a, b] = ok(await service.generate(USER, { style: { kind: "preset", presetId: "work" }, count: 3 }));
    await service.updateStatus(USER, a!.id, { status: "saved" });
    await service.updateStatus(USER, b!.id, { status: "liked" });
    await service.generate(USER, { style: { kind: "preset", presetId: "work" }, count: 3 });
    expect(lastHints().size).toBe(0);
  });

  it("re-rejecting after an undo writes a second reject row (history), and the hint comes back", async () => {
    const [a] = ok(await service.generate(USER, { style: { kind: "preset", presetId: "work" }, count: 3 }));
    await service.updateStatus(USER, a!.id, { status: "rejected", reason: "one" });
    await service.updateStatus(USER, a!.id, { status: "suggested" });
    await service.updateStatus(USER, a!.id, { status: "rejected", reason: "two" });
    expect(mock.listOutfitFeedback().map((f) => f.detail)).toEqual(["one", "two"]);
    await service.generate(USER, { style: { kind: "preset", presetId: "work" }, count: 3 });
    expect(lastHints().size).toBeGreaterThan(0);
  });
});
