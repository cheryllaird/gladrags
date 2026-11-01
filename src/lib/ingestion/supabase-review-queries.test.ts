/**
 * What the Supabase item repository asks PostgREST for in milestone 5: the
 * review columns are read and written, the review filter is applied, and
 * every new update is scoped to the signed-in user (on top of RLS). A
 * recording fake of the query builder; no network.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { tagging } from "@/test/fixtures/model-output";
import { TEST_USER } from "@/test/ingestion-deps";
import { SupabaseItemRepository } from "./items-repository";

type Call = [method: string, ...args: unknown[]];

function fakeClient(data: unknown = null) {
  const calls: Call[] = [];
  const client = {
    from(table: string) {
      calls.push(["from", table]);
      const chain: Record<string | symbol, unknown> = new Proxy(
        {},
        {
          get(_target, prop) {
            if (prop === "then") return (resolve: (v: unknown) => void) => resolve({ data, error: null });
            return (...args: unknown[]) => {
              calls.push([String(prop), ...args]);
              return chain;
            };
          },
        },
      );
      return chain;
    },
  };
  return { client: client as unknown as SupabaseClient, calls };
}

const ID = "4d000000-0000-4000-8000-000000000001";
const find = (calls: Call[], method: string) => calls.filter(([m]) => m === method).map(([, ...args]) => args);

describe("SupabaseItemRepository, milestone 5", () => {
  it("reads needs_review and needs_photo with every item", async () => {
    const { client, calls } = fakeClient([]);
    await new SupabaseItemRepository(client).list(TEST_USER, {});
    expect(String(find(calls, "select")[0]![0])).toMatch(/needs_review, needs_photo/);
  });

  it.each([true, false])("filters the list on needsReview=%s", async (value) => {
    const { client, calls } = fakeClient([]);
    await new SupabaseItemRepository(client).list(TEST_USER, { needsReview: value });
    expect(find(calls, "eq")).toContainEqual(["needs_review", value]);
  });

  it("doesn't filter on needs_review without the query", async () => {
    const { client, calls } = fakeClient([]);
    await new SupabaseItemRepository(client).list(TEST_USER, {});
    expect(find(calls, "eq").some(([column]) => column === "needs_review")).toBe(false);
  });

  it("inserts the review and photo flags", async () => {
    const { client, calls } = fakeClient(null);
    await new SupabaseItemRepository(client)
      .create(TEST_USER, {
        source: "email",
        sourceUrl: null,
        originalImageKey: `${TEST_USER}/a.png`,
        cutoutImageKey: null,
        tags: tagging.valid as never,
        tagsEdited: false,
        needsReview: true,
        needsPhoto: true,
      })
      .catch(() => {}); // the fake returns no row
    expect(find(calls, "insert")[0]![0]).toMatchObject({ source: "email", needs_review: true, needs_photo: true, user_id: TEST_USER });
  });

  it("a reviewed draft is inserted with both flags false", async () => {
    const { client, calls } = fakeClient(null);
    await new SupabaseItemRepository(client)
      .create(TEST_USER, {
        source: "photo",
        sourceUrl: null,
        originalImageKey: `${TEST_USER}/a.jpg`,
        cutoutImageKey: null,
        tags: tagging.valid as never,
        tagsEdited: true,
      })
      .catch(() => {});
    expect(find(calls, "insert")[0]![0]).toMatchObject({ needs_review: false, needs_photo: false });
  });

  it.each([
    ["updateTags", (r: SupabaseItemRepository) => r.updateTags(TEST_USER, ID, tagging.valid as never), { tags_edited: true, needs_review: false }],
    ["markReviewed", (r: SupabaseItemRepository) => r.markReviewed(TEST_USER, ID), { needs_review: false }],
    [
      "setCutoutKey",
      (r: SupabaseItemRepository) => r.setCutoutKey(TEST_USER, ID, `${TEST_USER}/c.png`, `${TEST_USER}/o.jpg`),
      { cutout_image_key: `${TEST_USER}/c.png` },
    ],
    [
      "replaceOriginal",
      (r: SupabaseItemRepository) => r.replaceOriginal(TEST_USER, ID, `${TEST_USER}/o.jpg`),
      { original_image_key: `${TEST_USER}/o.jpg`, cutout_image_key: null, needs_photo: false, needs_review: true },
    ],
  ])("%s updates the user's own row only", async (_name, run, columns) => {
    const { client, calls } = fakeClient(null);
    await run(new SupabaseItemRepository(client));
    expect(find(calls, "update")[0]![0]).toMatchObject(columns);
    expect(find(calls, "eq")).toContainEqual(["user_id", TEST_USER]);
    expect(find(calls, "eq")).toContainEqual(["id", ID]);
  });

  it("setCutoutKey only updates while the original is still the one the cut-out was made from", async () => {
    const { client, calls } = fakeClient(null);
    await new SupabaseItemRepository(client).setCutoutKey(TEST_USER, ID, `${TEST_USER}/c.png`, `${TEST_USER}/o.jpg`);
    expect(find(calls, "eq")).toContainEqual(["original_image_key", `${TEST_USER}/o.jpg`]);
  });

  it("markManyReviewed updates the user's rows among the IDs and counts them", async () => {
    const { client, calls } = fakeClient([{ id: ID }]);
    const updated = await new SupabaseItemRepository(client).markManyReviewed(TEST_USER, [ID, "4d000000-0000-4000-8000-000000000002"]);
    expect(updated).toBe(1);
    expect(find(calls, "update")[0]![0]).toEqual({ needs_review: false });
    expect(find(calls, "eq")).toContainEqual(["user_id", TEST_USER]);
    expect(find(calls, "in")[0]).toEqual(["id", [ID, "4d000000-0000-4000-8000-000000000002"]]);
  });
});
