/**
 * QA (round 2, P2): reading previews with outfits when signing goes wrong:
 * per-key signing errors, missing or mismatched URLs, odd rows, and a
 * previews table that can't be read.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredOutfitRequest } from "@/contracts";
import { FakeSupabase } from "@/test/fake-supabase";
import { entry, toItemRow, uuid } from "@/test/outfit-helpers";
import { SupabaseOutfitRepository } from "./supabase-repository";

const ALICE = "0c000000-0000-4000-8000-00000000001a";
const REQUEST: StoredOutfitRequest = { style: { kind: "preset", presetId: "work" }, guidance: null, anchorItemId: null, includeShopItems: false };

function previewRow(n: number, patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: uuid(n),
    user_id: ALICE,
    cache_key: String(n % 10).repeat(64),
    preset_id: "women_average_medium",
    item_ids: [uuid(1), uuid(2), uuid(3)],
    suggested_slots: [],
    status: "ready",
    image_key: `${ALICE}/${uuid(n + 100)}.webp`,
    failure_reason: null,
    attempted_at: "2026-11-14 09:00:00+00",
    created_at: "2026-11-14 09:00:00+00",
    updated_at: "2026-11-14 09:00:00+00",
    ...patch,
  };
}

let db: FakeSupabase;
let repo: SupabaseOutfitRepository;
let signCalls: { bucket: string; paths: string[] }[];

async function saveOne(name: string, previewN?: number) {
  const [outfit] = await repo.insertOutfits(ALICE, [{ request: REQUEST, name, reason: "R", itemIds: [uuid(1), uuid(2), uuid(3)], gaps: [], parentOutfitId: null }]);
  if (previewN !== undefined) Object.assign(db.tables.outfits!.find((o) => o.id === outfit!.id)!, { preview_id: uuid(previewN) });
  return outfit!;
}

/** Replace previews-bucket signing; other buckets keep the fake's. */
function signPreviewsWith(fn: (paths: string[]) => unknown) {
  const storage = db.storage.from;
  (db.storage as { from: unknown }).from = (bucket: string) =>
    bucket === "previews"
      ? {
          createSignedUrls: async (paths: string[]) => {
            signCalls.push({ bucket, paths });
            return fn(paths);
          },
        }
      : storage(bucket);
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  db = new FakeSupabase();
  db.tables.items!.push(toItemRow(entry(1, "top"), ALICE), toItemRow(entry(2, "bottom"), ALICE), toItemRow(entry(3, "shoes"), ALICE));
  db.tables.outfit_previews = [];
  repo = new SupabaseOutfitRepository(db.asClient());
  signCalls = [];
});

describe("QA reading previews: signing failures", () => {
  it("one key failing to sign fails only that outfit's preview (internal); the others stay ready", async () => {
    db.tables.outfit_previews!.push(previewRow(800), previewRow(801));
    await saveOne("A", 800);
    await saveOne("B", 801);
    const bad = `${ALICE}/${uuid(900)}.webp`;
    signPreviewsWith((paths) => ({
      data: paths.map((path) => (path === bad ? { path, signedUrl: "", error: "Object not found" } : { path, signedUrl: `https://signed.test/${path}`, error: null })),
      error: null,
    }));
    const byName = new Map((await repo.listOutfits(ALICE)).map((o) => [o.name, o.preview]));
    expect(byName.get("A")).toMatchObject({ status: "failed", failureReason: "internal", imageUrl: null });
    expect(byName.get("B")).toMatchObject({ status: "ready", imageUrl: `https://signed.test/${ALICE}/${uuid(901)}.webp` });
  });

  it("a per-key error with a URL present is still not used", async () => {
    db.tables.outfit_previews!.push(previewRow(800));
    const outfit = await saveOne("A", 800);
    signPreviewsWith((paths) => ({ data: paths.map((path) => ({ path, signedUrl: "https://signed.test/x", error: "denied" })), error: null }));
    expect((await repo.getOutfit(ALICE, outfit.id))!.preview).toMatchObject({ status: "failed", imageUrl: null });
  });

  it("a URL signed for a different path is never attached to this preview", async () => {
    db.tables.outfit_previews!.push(previewRow(800));
    const outfit = await saveOne("A", 800);
    signPreviewsWith(() => ({ data: [{ path: "someone-else/x.webp", signedUrl: "https://signed.test/someone-else", error: null }], error: null }));
    expect((await repo.getOutfit(ALICE, outfit.id))!.preview).toMatchObject({ status: "failed", imageUrl: null });
  });

  it("data null without an error: failed (internal), outfit still loads", async () => {
    db.tables.outfit_previews!.push(previewRow(800));
    const outfit = await saveOne("A", 800);
    signPreviewsWith(() => ({ data: null, error: null }));
    const read = await repo.getOutfit(ALICE, outfit.id);
    expect(read!.items).toHaveLength(3);
    expect(read!.preview).toMatchObject({ status: "failed", failureReason: "internal" });
  });

  it("only ready rows with a key are signed; one shared row is signed once", async () => {
    db.tables.outfit_previews!.push(
      previewRow(800),
      previewRow(801, { status: "pending", image_key: null }),
      previewRow(802, { status: "failed", image_key: null, failure_reason: "blocked" }),
      previewRow(803, { status: "ready", image_key: null }),
    );
    await saveOne("A", 800);
    await saveOne("A2", 800);
    await saveOne("B", 801);
    await saveOne("C", 802);
    await saveOne("D", 803);
    signPreviewsWith((paths) => ({ data: paths.map((path) => ({ path, signedUrl: `https://signed.test/${path}`, error: null })), error: null }));
    const byName = new Map((await repo.listOutfits(ALICE)).map((o) => [o.name, o.preview]));
    expect(signCalls).toEqual([{ bucket: "previews", paths: [`${ALICE}/${uuid(900)}.webp`] }]);
    expect(byName.get("A2")!.imageUrl).toBe(byName.get("A")!.imageUrl);
    // A ready row without a key can't be shown: read as failed rather than a broken image.
    expect(byName.get("D")).toMatchObject({ status: "failed", imageUrl: null });
  });

  it("no ready previews: the previews bucket isn't touched", async () => {
    db.tables.outfit_previews!.push(previewRow(801, { status: "pending", image_key: null }));
    await saveOne("B", 801);
    signPreviewsWith(() => {
      throw new Error("should not sign");
    });
    expect((await repo.listOutfits(ALICE))[0]!.preview.status).toBe("pending");
    expect(signCalls).toHaveLength(0);
  });

  it("a preview_id naming a row that's gone reads as none", async () => {
    const outfit = await saveOne("A", 899);
    expect((await repo.getOutfit(ALICE, outfit.id))!.preview.status).toBe("none");
  });

  // BUG (low): a failure reading outfit_previews fails the whole listing,
  // although signing failures fall back to the collage. The spec's fallback
  // ("the outfit keeps its collage") suggests the outfits should still load.
  it.fails("the previews table failing to read still loads the outfits (as no preview)", async () => {
    db.tables.outfit_previews!.push(previewRow(800));
    await saveOne("A", 800);
    db.failTable = "outfit_previews";
    const outfits = await repo.listOutfits(ALICE);
    expect(outfits).toHaveLength(1);
  });
});
