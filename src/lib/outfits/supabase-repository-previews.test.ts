/**
 * Round 2: outfits read through SupabaseOutfitRepository carry their
 * preview (the linked outfit_previews row, a signed image URL for a ready
 * one, outdated and refreshing), in every listing.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { NO_PREVIEW, OutfitSchema, type StoredOutfitRequest } from "@/contracts";
import { FakeSupabase } from "@/test/fake-supabase";
import { entry, toItemRow, uuid } from "@/test/outfit-helpers";
import { SupabaseOutfitRepository } from "./supabase-repository";

const ALICE = "0c000000-0000-4000-8000-00000000000a";
const BOB = "0c000000-0000-4000-8000-00000000000b";
const REQUEST: StoredOutfitRequest = { style: { kind: "preset", presetId: "work" }, guidance: null, anchorItemId: null, includeShopItems: false };
const KEY = "a".repeat(64);

function previewRow(id: string, userId: string, patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    user_id: userId,
    cache_key: KEY,
    preset_id: "women_average_medium",
    item_ids: [uuid(1), uuid(2), uuid(3)],
    suggested_slots: [],
    status: "ready",
    image_key: `${userId}/${uuid(900)}.webp`,
    failure_reason: null,
    attempted_at: "2026-11-14 09:00:00+00",
    created_at: "2026-11-14 09:00:00+00",
    updated_at: "2026-11-14 09:00:00+00",
    ...patch,
  };
}

let db: FakeSupabase;
let repo: SupabaseOutfitRepository;

async function saveOne(name = "A") {
  const [outfit] = await repo.insertOutfits(ALICE, [{ request: REQUEST, name, reason: "R", itemIds: [uuid(1), uuid(2), uuid(3)], gaps: [], parentOutfitId: null }]);
  return outfit!;
}

function link(outfitId: string, patch: Record<string, unknown>) {
  Object.assign(db.tables.outfits!.find((o) => o.id === outfitId)!, patch);
}

beforeEach(() => {
  db = new FakeSupabase();
  db.tables.items!.push(toItemRow(entry(1, "top"), ALICE), toItemRow(entry(2, "bottom"), ALICE), toItemRow(entry(3, "shoes"), ALICE));
  db.tables.outfit_previews = [];
  repo = new SupabaseOutfitRepository(db.asClient());
});

describe("SupabaseOutfitRepository previews", () => {
  it("reads an outfit without a preview as none", async () => {
    const outfit = await saveOne();
    expect(outfit.preview).toEqual(NO_PREVIEW);
  });

  it("signs a ready preview in the previews bucket for an hour", async () => {
    const outfit = await saveOne();
    const previewId = uuid(800);
    db.tables.outfit_previews!.push(previewRow(previewId, ALICE, { suggested_slots: ["shoes"] }));
    link(outfit.id, { preview_id: previewId });
    const read = (await repo.getOutfit(ALICE, outfit.id))!;
    expect(OutfitSchema.parse(read)).toEqual(read);
    expect(read.preview).toEqual({
      status: "ready",
      imageUrl: `https://signed.test/previews/${ALICE}/${uuid(900)}.webp?ttl=3600`,
      failureReason: null,
      presetId: "women_average_medium",
      suggestedSlots: ["shoes"],
      outdated: false,
      refreshing: false,
    });
  });

  it("shows outdated and refreshing while a refresh is pending, with the old picture", async () => {
    const outfit = await saveOne();
    db.tables.outfit_previews!.push(previewRow(uuid(800), ALICE), previewRow(uuid(801), ALICE, { status: "pending", image_key: null, cache_key: "b".repeat(64) }));
    link(outfit.id, { preview_id: uuid(800), pending_preview_id: uuid(801), preview_outdated: true });
    const { preview } = (await repo.getOutfit(ALICE, outfit.id))!;
    expect(preview).toMatchObject({ status: "ready", outdated: true, refreshing: true });
    expect(preview.imageUrl).toContain(`/previews/${ALICE}/`);
  });

  it("reads pending, failed and skipped previews with their reasons and no image", async () => {
    const [a, b, c] = [await saveOne("A"), await saveOne("B"), await saveOne("C")];
    db.tables.outfit_previews!.push(
      previewRow(uuid(800), ALICE, { status: "pending", image_key: null }),
      previewRow(uuid(801), ALICE, { status: "failed", image_key: null, failure_reason: "blocked", cache_key: "b".repeat(64) }),
      previewRow(uuid(802), ALICE, { status: "skipped", image_key: null, failure_reason: "daily_cap_reached", cache_key: "c".repeat(64) }),
    );
    link(a.id, { preview_id: uuid(800) });
    link(b.id, { preview_id: uuid(801) });
    link(c.id, { preview_id: uuid(802) });
    const byName = new Map((await repo.listOutfits(ALICE)).map((o) => [o.name, o.preview]));
    expect(byName.get("A")).toMatchObject({ status: "pending", imageUrl: null, failureReason: null });
    expect(byName.get("B")).toMatchObject({ status: "failed", imageUrl: null, failureReason: "blocked" });
    expect(byName.get("C")).toMatchObject({ status: "skipped", imageUrl: null, failureReason: "daily_cap_reached" });
  });

  it("shows previews in saved and rejected listings, sharing one row between outfits", async () => {
    const [a, b] = [await saveOne("A"), await saveOne("B")];
    db.tables.outfit_previews!.push(previewRow(uuid(800), ALICE));
    link(a.id, { preview_id: uuid(800) });
    link(b.id, { preview_id: uuid(800) });
    await repo.setStatus(ALICE, a.id, "saved");
    await repo.setStatus(ALICE, b.id, "rejected");
    const [saved] = await repo.listOutfits(ALICE, "saved");
    const [rejected] = await repo.listOutfits(ALICE, "rejected");
    expect(saved!.preview.status).toBe("ready");
    expect(rejected!.preview.imageUrl).toBe(saved!.preview.imageUrl);
  });

  it("ignores another user's preview row (reads as none)", async () => {
    const outfit = await saveOne();
    db.tables.outfit_previews!.push(previewRow(uuid(800), BOB));
    link(outfit.id, { preview_id: uuid(800) });
    expect((await repo.getOutfit(ALICE, outfit.id))!.preview.status).toBe("none");
  });

  it("reads a ready preview whose image can't be signed as failed (internal), still loading the outfit", async () => {
    const outfit = await saveOne();
    db.tables.outfit_previews!.push(previewRow(uuid(800), ALICE));
    link(outfit.id, { preview_id: uuid(800) });
    const storage = db.storage.from;
    (db.storage as { from: unknown }).from = (bucket: string) =>
      bucket === "previews" ? { createSignedUrls: async () => ({ data: null, error: { message: "storage down" } }) } : storage(bucket);
    expect((await repo.getOutfit(ALICE, outfit.id))!.preview).toMatchObject({ status: "failed", failureReason: "internal", imageUrl: null });
  });
});
