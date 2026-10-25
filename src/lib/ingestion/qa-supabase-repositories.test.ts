/**
 * QA gap tests for the Supabase-backed repositories, with a recording fake
 * of the supabase-js query builder (no network). The in-memory versions
 * don't run SQL, so these check what the real ones would ask PostgREST for:
 * every item query is scoped to the user (on top of RLS), the search is
 * escaped, and cleanup protects claimable add-by-link imports.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { LINK_IMPORT_TTL_SECONDS } from "@/contracts";
import { tagging } from "@/test/fixtures/model-output";
import { TEST_USER } from "@/test/ingestion-deps";
import { SupabaseImageReferences, SupabaseItemRepository, escapeLikePattern } from "./items-repository";

type Call = [method: string, ...args: unknown[]];

interface Recorded {
  table: string;
  calls: Call[];
}

/**
 * A chainable stand-in for `client.from(table)...`. Every method records
 * itself and returns the chain; awaiting the chain gives `result(table, calls)`.
 */
function fakeClient(result: (q: Recorded) => { data: unknown; error: unknown } = () => ({ data: [], error: null })) {
  const queries: Recorded[] = [];
  const client = {
    from(table: string) {
      const q: Recorded = { table, calls: [] };
      queries.push(q);
      const chain: Record<string | symbol, unknown> = new Proxy(
        {},
        {
          get(_target, prop) {
            if (prop === "then") {
              return (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
                try {
                  resolve(result(q));
                } catch (e) {
                  reject(e);
                }
              };
            }
            return (...args: unknown[]) => {
              q.calls.push([String(prop), ...args]);
              return chain;
            };
          },
        },
      );
      return chain;
    },
  };
  return { client: client as unknown as SupabaseClient, queries };
}

const has = (q: Recorded, method: string, ...args: unknown[]) =>
  q.calls.some(([m, ...a]) => m === method && JSON.stringify(a.slice(0, args.length)) === JSON.stringify(args));

const ID = "4d000000-0000-4000-8000-000000000001";

describe("SupabaseItemRepository scopes every query to the signed-in user", () => {
  it.each([
    ["list", (r: SupabaseItemRepository) => r.list(TEST_USER, {})],
    ["get", (r: SupabaseItemRepository) => r.get(TEST_USER, ID)],
    ["updateTags", (r: SupabaseItemRepository) => r.updateTags(TEST_USER, ID, tagging.valid as never)],
    ["delete", (r: SupabaseItemRepository) => r.delete(TEST_USER, ID)],
    ["keysInUse", (r: SupabaseItemRepository) => r.keysInUse(TEST_USER, [`${TEST_USER}/x.jpg`])],
  ])("%s filters user_id", async (_name, run) => {
    const { client, queries } = fakeClient((q) => ({
      data: q.calls.some(([m]) => m === "maybeSingle") ? null : [],
      error: null,
    }));
    await run(new SupabaseItemRepository(client));
    expect(queries.length).toBeGreaterThan(0);
    for (const q of queries) {
      expect(q.table).toBe("items");
      expect(has(q, "eq", "user_id", TEST_USER)).toBe(true);
    }
  });

  it("get/updateTags/delete of a row that isn't the user's come back null (the 404 path)", async () => {
    const { client } = fakeClient(() => ({ data: null, error: null }));
    const repo = new SupabaseItemRepository(client);
    expect(await repo.get(TEST_USER, ID)).toBeNull();
    expect(await repo.updateTags(TEST_USER, ID, tagging.valid as never)).toBeNull();
    expect(await repo.delete(TEST_USER, ID)).toBeNull();
  });

  it("updateTags always sets tags_edited", async () => {
    const { client, queries } = fakeClient(() => ({ data: null, error: null }));
    await new SupabaseItemRepository(client).updateTags(TEST_USER, ID, tagging.valid as never);
    const update = queries[0]!.calls.find(([m]) => m === "update")!;
    expect(update[1]).toMatchObject({ tags_edited: true, description: (tagging.valid as { description: string }).description });
  });

  it("database errors are thrown, not treated as 'not found'", async () => {
    const { client } = fakeClient(() => ({ data: null, error: { message: "boom" } }));
    await expect(new SupabaseItemRepository(client).get(TEST_USER, ID)).rejects.toThrow("boom");
  });

  it("a row that doesn't match the contract is refused rather than passed on", async () => {
    const { client } = fakeClient(() => ({ data: { id: ID, user_id: TEST_USER, category: "accessory" }, error: null }));
    await expect(new SupabaseItemRepository(client).get(TEST_USER, ID)).rejects.toThrow();
  });
});

describe("search escaping", () => {
  it("sends % and _ escaped inside the ILIKE pattern", async () => {
    const { client, queries } = fakeClient();
    await new SupabaseItemRepository(client).list(TEST_USER, { q: "50% off t_shirt\\" });
    const ilike = queries[0]!.calls.find(([m]) => m === "ilike")!;
    expect(ilike).toEqual(["ilike", "description", "%50\\% off t\\_shirt\\\\%"]);
  });

  it("escapeLikePattern leaves ordinary text alone", () => {
    expect(escapeLikePattern("Navy slim-fit chinos")).toBe("Navy slim-fit chinos");
  });

  it.fails("BUG (low): '*' is PostgREST's alias for % in like/ilike, so it must not reach the pattern unescaped", async () => {
    const { client, queries } = fakeClient();
    await new SupabaseItemRepository(client).list(TEST_USER, { q: "a*b" });
    const pattern = queries[0]!.calls.find(([m]) => m === "ilike")![2] as string;
    // With "%a*b%", PostgREST matches "a<anything>b": searching "*" lists everything.
    expect(pattern.slice(1, -1)).not.toContain("*");
  });

  it("filters are combined with the search", async () => {
    const { client, queries } = fakeClient();
    await new SupabaseItemRepository(client).list(TEST_USER, { category: "top", colour: "navy", occasion: "work", q: "x" });
    const q = queries[0]!;
    expect(has(q, "eq", "category", "top")).toBe(true);
    expect(has(q, "contains", "colours", ["navy"])).toBe(true);
    expect(has(q, "contains", "occasions", ["work"])).toBe(true);
    expect(has(q, "order", "created_at", { ascending: false })).toBe(true);
  });
});

describe("SupabaseImageReferences (cleanup's 'is this image still needed?')", () => {
  const now = new Date("2026-10-25T10:00:00Z");
  const keys = [`${TEST_USER}/a.jpg`, `${TEST_USER}/b.png`, `${TEST_USER}/c.jpg`];

  it("checks both image columns across all users, and link imports still inside their time limit", async () => {
    const { client, queries } = fakeClient((q) => {
      if (q.table === "link_imports") return { data: [{ original_image_key: keys[2] }], error: null };
      const column = (q.calls.find(([m]) => m === "select")![1] as string).trim();
      return { data: column === "original_image_key" ? [{ original_image_key: keys[0] }] : [{ cutout_image_key: keys[1] }], error: null };
    });
    const found = await new SupabaseImageReferences(client, () => now).referenced(keys);
    expect([...found].sort()).toEqual([...keys].sort());

    const itemQueries = queries.filter((q) => q.table === "items");
    expect(itemQueries).toHaveLength(2);
    for (const q of itemQueries) expect(q.calls.some(([m, col]) => m === "eq" && col === "user_id")).toBe(false);

    const link = queries.find((q) => q.table === "link_imports")!;
    const since = new Date(now.getTime() - LINK_IMPORT_TTL_SECONDS * 1000).toISOString();
    expect(has(link, "gt", "created_at", since)).toBe(true);
    expect(has(link, "in", "original_image_key", keys)).toBe(true);
  });

  it("an error from any lookup throws, so cleanup deletes nothing it can't vouch for", async () => {
    const { client } = fakeClient((q) => (q.table === "link_imports" ? { data: null, error: { message: "down" } } : { data: [], error: null }));
    await expect(new SupabaseImageReferences(client, () => now).referenced(keys)).rejects.toThrow("down");
  });

  it("no keys, no queries", async () => {
    const { client, queries } = fakeClient();
    expect((await new SupabaseImageReferences(client).referenced([])).size).toBe(0);
    expect(queries).toHaveLength(0);
  });
});
