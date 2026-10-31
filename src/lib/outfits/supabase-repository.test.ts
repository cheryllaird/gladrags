import { beforeEach, describe, expect, it } from "vitest";
import { OutfitSchema, type StoredOutfitRequest } from "@/contracts";
import { FakeSupabase } from "@/test/fake-supabase";
import { entry, toItemRow, uuid } from "@/test/outfit-helpers";
import { SupabaseOutfitRepository } from "./supabase-repository";

const ALICE = "0c000000-0000-4000-8000-00000000000a";
const BOB = "0c000000-0000-4000-8000-00000000000b";
const REQUEST: StoredOutfitRequest = { style: { kind: "preset", presetId: "work" }, guidance: null, anchorItemId: null, includeShopItems: false };

function itemRow(n: number, userId: string, category: Parameters<typeof entry>[1], withCutout = true): Record<string, unknown> {
  return toItemRow(entry(n, category), userId, { withCutout });
}

let db: FakeSupabase;
let repo: SupabaseOutfitRepository;

beforeEach(() => {
  db = new FakeSupabase();
  db.tables.items!.push(
    itemRow(1, ALICE, "top"),
    itemRow(2, ALICE, "bottom"),
    itemRow(3, ALICE, "shoes", false),
    itemRow(4, BOB, "top"),
  );
  repo = new SupabaseOutfitRepository(db.asClient());
});

describe("SupabaseOutfitRepository", () => {
  it("loads only the user's wardrobe, pointing thumbnails at the cut-out or the original", async () => {
    const items = await repo.listWardrobe(ALICE);
    expect(items.map((i) => i.id)).toEqual([uuid(1), uuid(2), uuid(3)]);
    expect(items[0]!.image).toEqual({ bucket: "cutouts", key: `${ALICE}/${uuid(601)}.png` });
    expect(items[2]!.image).toEqual({ bucket: "originals", key: `${ALICE}/${uuid(503)}.jpg` });
    expect(items[0]!.tags.category).toBe("top");
  });

  it("saves outfits in ranked order and returns them with signed item images", async () => {
    const saved = await repo.insertOutfits(ALICE, [
      { request: REQUEST, name: "First", reason: "Best", itemIds: [uuid(1), uuid(2), uuid(3)], parentOutfitId: null },
      { request: REQUEST, name: "Second", reason: "Next", itemIds: [uuid(2), uuid(1), uuid(3)], parentOutfitId: null },
    ]);
    expect(saved.map((o) => o.name)).toEqual(["First", "Second"]);
    for (const outfit of saved) expect(OutfitSchema.parse(outfit)).toEqual(outfit);
    const [first] = saved;
    expect(first!.status).toBe("suggested");
    expect(first!.items.map((i) => i.id)).toEqual(first!.itemIds);
    expect(first!.items[0]!.cutoutUrl).toBe(`https://signed.test/cutouts/${ALICE}/${uuid(601)}.png?ttl=3600`);
    expect(first!.items[2]!.cutoutUrl).toBeNull(); // no cut-out: the UI shows originalUrl
    expect(first!.items[2]!.originalUrl).toContain(`/originals/${ALICE}/`);
    expect(db.tables.outfits![0]).toMatchObject({ user_id: ALICE, item_ids: [uuid(1), uuid(2), uuid(3)], parent_outfit_id: null });
  });

  it("stores parent_outfit_id for refinements", async () => {
    const [parent] = await repo.insertOutfits(ALICE, [{ request: REQUEST, name: "P", reason: "R", itemIds: [uuid(1), uuid(2), uuid(3)], parentOutfitId: null }]);
    const [child] = await repo.insertOutfits(ALICE, [{ request: REQUEST, name: "C", reason: "R", itemIds: [uuid(2), uuid(1), uuid(3)], parentOutfitId: parent!.id }]);
    expect(child!.parentOutfitId).toBe(parent!.id);
    expect(db.tables.outfits![1]!.parent_outfit_id).toBe(parent!.id);
  });

  it("lists newest first, by status, and hides other users' outfits", async () => {
    const [a] = await repo.insertOutfits(ALICE, [{ request: REQUEST, name: "A", reason: "R", itemIds: [uuid(1), uuid(2), uuid(3)], parentOutfitId: null }]);
    const [b] = await repo.insertOutfits(ALICE, [{ request: REQUEST, name: "B", reason: "R", itemIds: [uuid(2), uuid(1), uuid(3)], parentOutfitId: null }]);
    await repo.setStatus(ALICE, a!.id, "saved");
    expect((await repo.listOutfits(ALICE)).map((o) => o.name)).toEqual(["B", "A"]);
    expect((await repo.listOutfits(ALICE, "saved")).map((o) => o.id)).toEqual([a!.id]);
    expect(await repo.listOutfits(BOB)).toEqual([]);
    expect(await repo.getOutfit(BOB, b!.id)).toBeNull();
    expect(await repo.setStatus(BOB, b!.id, "rejected")).toBeNull();
    expect((await repo.getOutfit(ALICE, b!.id))!.status).toBe("suggested");
  });

  it("lists rejected outfits' item IDs, newest first", async () => {
    const [a, b] = await repo.insertOutfits(ALICE, [
      { request: REQUEST, name: "A", reason: "R", itemIds: [uuid(1), uuid(2), uuid(3)], parentOutfitId: null },
      { request: REQUEST, name: "B", reason: "R", itemIds: [uuid(2), uuid(1), uuid(3)], parentOutfitId: null },
    ]);
    await repo.setStatus(ALICE, a!.id, "rejected");
    await repo.setStatus(ALICE, b!.id, "rejected");
    expect(await repo.listRejectedItemIds(ALICE, 30)).toEqual([b!.itemIds, a!.itemIds]);
    expect(await repo.listRejectedItemIds(ALICE, 1)).toEqual([b!.itemIds]);
  });

  it("records feedback rows", async () => {
    await repo.addFeedback(ALICE, uuid(77), "reject", "too formal");
    expect(db.tables.outfit_feedback).toEqual([expect.objectContaining({ user_id: ALICE, outfit_id: uuid(77), kind: "reject", detail: "too formal" })]);
  });

  it("skips an outfit whose item has gone (deleted mid-request)", async () => {
    const [a] = await repo.insertOutfits(ALICE, [{ request: REQUEST, name: "A", reason: "R", itemIds: [uuid(1), uuid(2), uuid(3)], parentOutfitId: null }]);
    db.tables.items = db.tables.items!.filter((i) => i.id !== uuid(3));
    expect(await repo.getOutfit(ALICE, a!.id)).toBeNull();
  });

  it("turns database errors into thrown errors (500 internal)", async () => {
    db.failTable = "items";
    await expect(repo.listWardrobe(ALICE)).rejects.toThrow("Couldn't load the wardrobe: items is down");
  });

  it("rejects rows that don't match the schema", async () => {
    db.tables.items![0]!.category = "accessory";
    await expect(repo.listWardrobe(ALICE)).rejects.toThrow();
  });
});
