/**
 * The Supabase link_imports repository, with a recording fake of the
 * supabase-js query builder (no network): every query is scoped to the
 * user, the claim is ONE conditional update (unused, inside the time
 * limit) that returns the row, and rows read back are validated.
 * Plus the old-row cleanup.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { LINK_IMPORT_TTL_SECONDS } from "@/contracts";
import { TEST_USER } from "@/test/ingestion-deps";
import { LINK_IMPORT_ROW_MAX_AGE_MS, cleanUpOldLinkImports } from "./cleanup";
import { InMemoryLinkImportRepository, SupabaseLinkImportRepository } from "./repository";

type Call = [method: string, ...args: unknown[]];
interface Recorded {
  table: string;
  calls: Call[];
}

function fakeClient(result: (q: Recorded) => { data: unknown; error: unknown }) {
  const queries: Recorded[] = [];
  const client = {
    from(table: string) {
      const q: Recorded = { table, calls: [] };
      queries.push(q);
      const chain: Record<string | symbol, unknown> = new Proxy(
        {},
        {
          get(_target, prop) {
            if (prop === "then") return (resolve: (v: unknown) => void) => resolve(result(q));
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

const NOW = new Date("2026-10-25T10:00:00Z");
const SINCE = new Date(NOW.getTime() - LINK_IMPORT_TTL_SECONDS * 1000).toISOString();
const KEY = `${TEST_USER}/1a000000-0000-4000-8000-000000000099.jpg`;
const ROW = { source_url: "https://shop.example/p", product: { title: "Shirt", brand: null, colour: "Navy" } };

describe("SupabaseLinkImportRepository", () => {
  it("create inserts the row with the user, URL, key and product", async () => {
    const { client, queries } = fakeClient(() => ({ data: null, error: null }));
    await new SupabaseLinkImportRepository(client, () => NOW).create({
      userId: TEST_USER,
      sourceUrl: ROW.source_url,
      originalImageKey: KEY,
      product: ROW.product,
    });
    expect(queries[0]!.table).toBe("link_imports");
    expect(has(queries[0]!, "insert", { user_id: TEST_USER, source_url: ROW.source_url, original_image_key: KEY, product: ROW.product })).toBe(true);
  });

  it("claim is one conditional UPDATE ... RETURNING: user's, unused, inside the time limit", async () => {
    const { client, queries } = fakeClient(() => ({ data: ROW, error: null }));
    const claimed = await new SupabaseLinkImportRepository(client, () => NOW).claim(TEST_USER, KEY);
    expect(claimed).toEqual({ sourceUrl: ROW.source_url, product: ROW.product });
    expect(queries).toHaveLength(1);
    const q = queries[0]!;
    expect(has(q, "update", { tagged_at: NOW.toISOString() })).toBe(true);
    expect(has(q, "eq", "user_id", TEST_USER)).toBe(true);
    expect(has(q, "eq", "original_image_key", KEY)).toBe(true);
    expect(has(q, "is", "tagged_at", null)).toBe(true);
    expect(has(q, "gt", "created_at", SINCE)).toBe(true);
    expect(has(q, "select", "source_url, product")).toBe(true);
    expect(has(q, "maybeSingle")).toBe(true);
  });

  it("findOpen is the same filters as a read, without updating", async () => {
    const { client, queries } = fakeClient(() => ({ data: ROW, error: null }));
    await new SupabaseLinkImportRepository(client, () => NOW).findOpen(TEST_USER, KEY);
    const q = queries[0]!;
    expect(q.calls.some(([m]) => m === "update")).toBe(false);
    expect(has(q, "eq", "user_id", TEST_USER)).toBe(true);
    expect(has(q, "is", "tagged_at", null)).toBe(true);
    expect(has(q, "gt", "created_at", SINCE)).toBe(true);
  });

  it("no row means null", async () => {
    const { client } = fakeClient(() => ({ data: null, error: null }));
    const repo = new SupabaseLinkImportRepository(client, () => NOW);
    expect(await repo.claim(TEST_USER, KEY)).toBeNull();
    expect(await repo.findOpen(TEST_USER, KEY)).toBeNull();
  });

  it("validates what comes back: stored product text is cleaned again, a bad URL is refused", async () => {
    const { client } = fakeClient(() => ({ data: { ...ROW, product: { title: "Two\nlines", brand: "", colour: null } }, error: null }));
    expect(await new SupabaseLinkImportRepository(client, () => NOW).claim(TEST_USER, KEY)).toEqual({
      sourceUrl: ROW.source_url,
      product: { title: "Two lines", brand: null, colour: null },
    });
    const bad = fakeClient(() => ({ data: { ...ROW, source_url: "javascript:alert(1)" }, error: null }));
    await expect(new SupabaseLinkImportRepository(bad.client, () => NOW).claim(TEST_USER, KEY)).rejects.toThrow();
  });

  it("database errors are thrown, not read as 'no import'", async () => {
    const { client } = fakeClient(() => ({ data: null, error: { message: "down" } }));
    const repo = new SupabaseLinkImportRepository(client, () => NOW);
    await expect(repo.claim(TEST_USER, KEY)).rejects.toThrow("down");
    await expect(repo.findOpen(TEST_USER, KEY)).rejects.toThrow("down");
    await expect(repo.create({ userId: TEST_USER, sourceUrl: ROW.source_url, originalImageKey: KEY, product: ROW.product })).rejects.toThrow("down");
  });

  it("deleteCreatedBefore deletes by age", async () => {
    const { client, queries } = fakeClient(() => ({ data: [{ id: "a" }, { id: "b" }], error: null }));
    expect(await new SupabaseLinkImportRepository(client, () => NOW).deleteCreatedBefore(NOW)).toBe(2);
    expect(has(queries[0]!, "delete")).toBe(true);
    expect(has(queries[0]!, "lt", "created_at", NOW.toISOString())).toBe(true);
  });
});

describe("cleanUpOldLinkImports", () => {
  it("deletes rows older than a week, used or not, and keeps newer ones", async () => {
    let now = new Date("2026-10-01T10:00:00Z");
    const repo = new InMemoryLinkImportRepository(() => now);
    const product = { title: null, brand: null, colour: null };
    await repo.create({ userId: TEST_USER, sourceUrl: "https://a.example/", originalImageKey: `${TEST_USER}/0a000000-0000-4000-8000-000000000001.jpg`, product });
    await repo.claim(TEST_USER, `${TEST_USER}/0a000000-0000-4000-8000-000000000001.jpg`);
    now = new Date(now.getTime() + LINK_IMPORT_ROW_MAX_AGE_MS - 60_000);
    await repo.create({ userId: TEST_USER, sourceUrl: "https://b.example/", originalImageKey: `${TEST_USER}/0a000000-0000-4000-8000-000000000002.jpg`, product });
    now = new Date(now.getTime() + 120_000);
    expect(await cleanUpOldLinkImports(repo, () => now)).toEqual({ deleted: 1 });
    expect([...repo.rows.values()].map((r) => r.sourceUrl)).toEqual(["https://b.example/"]);
  });
});
