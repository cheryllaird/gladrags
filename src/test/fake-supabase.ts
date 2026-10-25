/**
 * A small in-memory stand-in for the Supabase client: just the query
 * builder calls the outfit repository uses (select / insert / update with
 * eq, in, order, limit, maybeSingle) and storage signing and downloads.
 * No network. Test-only.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

type Row = Record<string, unknown>;
type Result = { data: unknown; error: { message: string } | null };

export class FakeSupabase {
  readonly tables: Record<string, Row[]> = { items: [], outfits: [], outfit_feedback: [] };
  /** "bucket/key" -> bytes */
  readonly objects = new Map<string, Uint8Array>();
  /** Make every query on this table fail. */
  failTable: string | null = null;
  private clock = Date.parse("2026-10-25T09:00:00Z");

  nextTimestamp(): string {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }

  from(table: string) {
    return new Query(this, table);
  }

  readonly storage = {
    from: (bucket: string) => ({
      createSignedUrls: async (paths: string[], expiresIn: number) => ({
        data: paths.map((path) => ({ path, signedUrl: `https://signed.test/${bucket}/${path}?ttl=${expiresIn}`, error: null })),
        error: null,
      }),
      download: async (path: string) => {
        const bytes = this.objects.get(`${bucket}/${path}`);
        if (!bytes) return { data: null, error: { message: "Object not found" } };
        return { data: new Blob([bytes as Uint8Array<ArrayBuffer>]), error: null };
      },
    }),
  };

  asClient(): SupabaseClient {
    return this as unknown as SupabaseClient;
  }
}

class Query implements PromiseLike<Result> {
  private op: "select" | "insert" | "update" = "select";
  private payload: Row[] = [];
  private patch: Row = {};
  private filters: ((row: Row) => boolean)[] = [];
  private orderBy: { column: string; ascending: boolean } | null = null;
  private limitTo: number | null = null;
  private single = false;

  constructor(
    private readonly db: FakeSupabase,
    private readonly table: string,
  ) {}

  select(_columns?: string) {
    return this;
  }

  insert(rows: Row | Row[]) {
    this.op = "insert";
    this.payload = Array.isArray(rows) ? rows : [rows];
    return this;
  }

  update(patch: Row) {
    this.op = "update";
    this.patch = patch;
    return this;
  }

  eq(column: string, value: unknown) {
    this.filters.push((row) => row[column] === value);
    return this;
  }

  in(column: string, values: unknown[]) {
    this.filters.push((row) => values.includes(row[column]));
    return this;
  }

  order(column: string, { ascending = true }: { ascending?: boolean } = {}) {
    this.orderBy = { column, ascending };
    return this;
  }

  limit(n: number) {
    this.limitTo = n;
    return this;
  }

  maybeSingle() {
    this.single = true;
    return this;
  }

  then<A = Result, B = never>(onFulfilled?: ((value: Result) => A | PromiseLike<A>) | null, onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null) {
    return Promise.resolve(this.run()).then(onFulfilled, onRejected);
  }

  private run(): Result {
    if (this.db.failTable === this.table) return { data: null, error: { message: `${this.table} is down` } };
    const table = (this.db.tables[this.table] ??= []);
    let rows: Row[];
    if (this.op === "insert") {
      rows = this.payload.map((row) => ({ id: crypto.randomUUID(), created_at: this.db.nextTimestamp(), ...row }));
      table.push(...rows);
    } else {
      rows = table.filter((row) => this.filters.every((f) => f(row)));
      if (this.op === "update") for (const row of rows) Object.assign(row, this.patch);
    }
    if (this.orderBy) {
      const { column, ascending } = this.orderBy;
      rows = [...rows].sort((a, b) => String(a[column]).localeCompare(String(b[column])) * (ascending ? 1 : -1));
    }
    if (this.limitTo !== null) rows = rows.slice(0, this.limitTo);
    const copies = rows.map((r) => structuredClone(r));
    return { data: this.single ? (copies[0] ?? null) : copies, error: null };
  }
}
