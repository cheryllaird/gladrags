import { expect, test } from "@playwright/test";

// The outfit engine over real HTTP, in mock mode: the real pipeline
// (filter, candidates, validation, refinement, feedback) with the mock
// ranking model. The mock store is shared by every test on the server, so
// these only ever ADD outfits. Each run uses 4 of the mock user's 25 daily
// outfit requests; restart a long-lived local server after a few runs.

interface Item {
  id: string;
  tags: { category: string };
}
interface Outfit {
  id: string;
  itemIds: string[];
  items: Item[];
  status: string;
  parentOutfitId: string | null;
  request: { guidance: string | null; anchorItemId: string | null };
}

test.describe("outfit engine (mock mode)", () => {
  test("builds around an item, swaps one piece, refines with guidance, and rejects", async ({ request }) => {
    const items = ((await (await request.get("/api/items")).json()) as { items: Item[] }).items;
    const anchor = items.find((i) => i.tags.category === "bottom")!;

    // Build around the anchor.
    const first = await (
      await request.post("/api/outfits", { data: { style: { kind: "preset", presetId: "smart_casual" }, anchorItemId: anchor.id, count: 3 } })
    ).json();
    expect(first.status).toBe("ok");
    for (const o of first.outfits as Outfit[]) expect(o.itemIds).toContain(anchor.id);
    const outfit = first.outfits[0] as Outfit;

    // Swap the shoes: new outfits link back, keep the anchor, drop those shoes.
    const shoes = outfit.items.find((i) => i.tags.category === "shoes")!;
    const swapped = await (await request.post(`/api/outfits/${outfit.id}/refine`, { data: { kind: "swap", itemId: shoes.id } })).json();
    if (swapped.status === "ok") {
      for (const o of swapped.outfits as Outfit[]) {
        expect(o.parentOutfitId).toBe(outfit.id);
        expect(o.itemIds).not.toContain(shoes.id);
        expect(o.itemIds).toContain(anchor.id);
      }
    } else {
      expect(swapped.reason).toBe("missing_category");
    }

    // Guidance refinement keeps the guidance on the request.
    const warmer = await (await request.post(`/api/outfits/${outfit.id}/refine`, { data: { kind: "guidance", text: "warmer" } })).json();
    expect(warmer.status).toBe("ok");
    expect((warmer.outfits as Outfit[])[0]!.request.guidance).toBe("warmer");
    expect((warmer.outfits as Outfit[])[0]!.parentOutfitId).toBe(outfit.id);

    // Reject it, with a reason.
    const rejected = await (await request.patch(`/api/outfits/${outfit.id}`, { data: { status: "rejected", reason: "not me" } })).json();
    expect(rejected.outfit.status).toBe("rejected");
    const list = (await (await request.get("/api/outfits?status=rejected")).json()) as { outfits: Outfit[] };
    expect(list.outfits.map((o) => o.id)).toContain(outfit.id);
  });

  test("mock markers give the paused and cap errors", async ({ request }) => {
    const paused = await request.post("/api/outfits", { data: { style: { kind: "custom", text: "party mock-ai-paused" } } });
    expect(paused.status()).toBe(503);
    expect((await paused.json()).error.code).toBe("ai_paused");
    const capped = await request.post("/api/outfits", { data: { style: { kind: "preset", presetId: "work" }, guidance: "mock-daily-cap" } });
    expect(capped.status()).toBe(429);
    expect((await capped.json()).error.cap.kind).toBe("outfit_requests_per_day");
  });
});
