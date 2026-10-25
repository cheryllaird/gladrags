import { expect, test, type APIRequestContext } from "@playwright/test";

// QA: journeys 2–5 at the API level, in mock mode (the real pipeline with
// the mock ranking model). The outfit screens belong to outfit-ui and
// aren't on this branch, so these drive the HTTP API the screens will use.
//
// Budget: these make up to 8 counted outfit requests. With the other specs a run
// uses about 13 of the mock user's 25 a day; restart a long-lived local
// server after a run or two. The mock store is shared, so these only add
// outfits, and only change the status of outfits they created.

interface Item {
  id: string;
  tags: { category: string; description: string };
}
interface Outfit {
  id: string;
  name: string;
  reason: string;
  itemIds: string[];
  items: Item[];
  status: string;
  parentOutfitId: string | null;
  request: { style: unknown; guidance: string | null; anchorItemId: string | null };
}

function expectWearable(outfit: Outfit) {
  expect(outfit.items.map((i) => i.id)).toEqual(outfit.itemIds);
  const count = (c: string) => outfit.items.filter((i) => i.tags.category === c).length;
  const separates = count("top") === 1 && count("bottom") === 1 && count("dress_jumpsuit") === 0;
  const onePiece = count("dress_jumpsuit") === 1 && count("top") === 0 && count("bottom") === 0;
  expect(separates || onePiece).toBe(true);
  expect(count("shoes")).toBe(1);
  expect(count("outerwear")).toBeLessThanOrEqual(1);
  expect(outfit.name.length).toBeGreaterThan(0);
  expect(outfit.reason.length).toBeGreaterThan(0);
  expect(`${outfit.name} ${outfit.reason}`).not.toMatch(/\bI\d+\b/);
}

async function items(request: APIRequestContext): Promise<Item[]> {
  return ((await (await request.get("/api/items")).json()) as { items: Item[] }).items;
}

async function ask(request: APIRequestContext, data: unknown) {
  const res = await request.post("/api/outfits", { data });
  expect(res.status()).toBe(200);
  return (await res.json()) as { status: string; outfits: Outfit[]; reason?: string; missingCategories?: string[] };
}

test.describe("QA journeys 2–5 over the outfit API (mock mode)", () => {
  test("journey 2: a preset style with guidance gives 3–5 wearable outfits", async ({ request }) => {
    const body = await ask(request, { style: { kind: "preset", presetId: "smart_casual" }, guidance: "no heels", count: 5 });
    expect(body.status).toBe("ok");
    expect(body.outfits.length).toBeGreaterThanOrEqual(3);
    expect(body.outfits.length).toBeLessThanOrEqual(5);
    const keys = new Set(body.outfits.map((o) => [...o.itemIds].sort().join()));
    expect(keys.size).toBe(body.outfits.length);
    for (const o of body.outfits) {
      expectWearable(o);
      expect(o.status).toBe("suggested");
      expect(o.request.guidance).toBe("no heels");
      expect(o.parentOutfitId).toBeNull();
    }
  });

  test("journey 2: a typed (custom) style works too", async ({ request }) => {
    const body = await ask(request, { style: { kind: "custom", text: "garden party" }, count: 3 });
    expect(body.status).toBe("ok");
    for (const o of body.outfits) expectWearable(o);
  });

  test("journey 3: build around shoes and around outerwear; every outfit includes the item", async ({ request }) => {
    const all = await items(request);
    for (const category of ["shoes", "outerwear"]) {
      const anchor = all.find((i) => i.tags.category === category)!;
      const body = await ask(request, { style: { kind: "preset", presetId: "smart_casual" }, anchorItemId: anchor.id, count: 3 });
      expect(body.status, `${category} anchor`).toBe("ok");
      for (const o of body.outfits) {
        expectWearable(o);
        expect(o.itemIds).toContain(anchor.id);
        expect(o.request.anchorItemId).toBe(anchor.id);
      }
    }
  });

  test("journey 3: an unknown anchor is 404", async ({ request }) => {
    const res = await request.post("/api/outfits", {
      data: { style: { kind: "preset", presetId: "work" }, anchorItemId: "9f000000-0000-4000-8000-000000000000" },
    });
    expect(res.status()).toBe(404);
    expect((await res.json()).error.code).toBe("not_found");
  });

  test("journey 4: swap the top, then refine with guidance; revised sets link back", async ({ request }) => {
    const first = await ask(request, { style: { kind: "preset", presetId: "work" }, count: 3 });
    expect(first.status).toBe("ok");
    const parent = first.outfits.find((o) => o.items.some((i) => i.tags.category === "top")) ?? first.outfits[0]!;
    const swapOut = parent.items.find((i) => i.tags.category === "top") ?? parent.items[0]!;

    const swapRes = await request.post(`/api/outfits/${parent.id}/refine`, { data: { kind: "swap", itemId: swapOut.id } });
    expect(swapRes.status()).toBe(200);
    const swapped = (await swapRes.json()) as { status: string; outfits: Outfit[]; reason?: string };
    if (swapped.status === "ok") {
      expect(swapped.outfits.length).toBeLessThanOrEqual(3);
      for (const o of swapped.outfits) {
        expectWearable(o);
        expect(o.parentOutfitId).toBe(parent.id);
        expect(o.itemIds).not.toContain(swapOut.id);
      }
    } else {
      expect(["missing_category", "nothing_fits"]).toContain(swapped.reason);
    }

    const guided = (await (
      await request.post(`/api/outfits/${parent.id}/refine`, { data: { kind: "guidance", text: "less formal" } })
    ).json()) as { status: string; outfits: Outfit[] };
    expect(guided.status).toBe("ok");
    const parentKey = [...parent.itemIds].sort().join();
    for (const o of guided.outfits) {
      expectWearable(o);
      expect(o.parentOutfitId).toBe(parent.id);
      expect([...o.itemIds].sort().join()).not.toBe(parentKey);
      expect(o.request.guidance).toBe("less formal");
    }

    const bad = await request.post(`/api/outfits/${parent.id}/refine`, { data: { kind: "swap", itemId: "9f000000-0000-4000-8000-000000000000" } });
    expect(bad.status()).toBe(400);
  });

  test("journey 5: save, like and reject; saved and liked lists show them", async ({ request }) => {
    const body = await ask(request, { style: { kind: "preset", presetId: "casual" }, count: 3 });
    expect(body.status).toBe("ok");
    const [a, b, c] = body.outfits;
    const setStatus = async (id: string, data: unknown) => {
      const res = await request.patch(`/api/outfits/${id}`, { data });
      expect(res.status()).toBe(200);
      return ((await res.json()) as { outfit: Outfit }).outfit;
    };
    expect((await setStatus(a!.id, { status: "saved" })).status).toBe("saved");
    if (b) expect((await setStatus(b.id, { status: "liked" })).status).toBe("liked");
    if (c) expect((await setStatus(c.id, { status: "rejected", reason: "not my colours" })).status).toBe("rejected");

    const list = async (status: string) =>
      ((await (await request.get(`/api/outfits?status=${status}`)).json()) as { outfits: Outfit[] }).outfits.map((o) => o.id);
    expect(await list("saved")).toContain(a!.id);
    if (b) expect(await list("liked")).toContain(b.id);
    if (c) expect(await list("rejected")).toContain(c.id);

    const one = (await (await request.get(`/api/outfits/${a!.id}`)).json()) as { outfit: Outfit };
    expect(one.outfit.status).toBe("saved");
    expectWearable(one.outfit);

    const badStatus = await request.patch(`/api/outfits/${a!.id}`, { data: { status: "archived" } });
    expect(badStatus.status()).toBe(400);
    const unknown = await request.patch(`/api/outfits/9f000000-0000-4000-8000-000000000000`, { data: { status: "saved" } });
    expect(unknown.status()).toBe(404);
  });
});
